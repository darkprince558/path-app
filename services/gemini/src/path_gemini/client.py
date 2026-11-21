"""Provider interface and the Google ``google-genai`` adapter.

``service.py`` depends only on ``GeminiClient`` and ``ProviderResponse``, so
tests and Sam's backend can inject a fake. All Google-specific code is here.

The adapter makes exactly one HTTP attempt per call (SDK retries disabled);
the service owns retries. Provider exceptions are translated into typed
``LandmarkError`` subclasses ``from None``, so SDK messages, which can echo
request or response content, never propagate.
"""

from dataclasses import dataclass
from typing import Optional

from .errors import (
    ConfigurationError,
    GeminiAuthenticationError,
    GeminiRateLimitedError,
    GeminiTimeoutError,
    GeminiUnavailableError,
    InvalidRequestError,
    LandmarkError,
)
from .models import UsageMetadata
from .prompt import PromptBundle

try:  # Protocol is in typing from 3.8; keep the import local for clarity.
    from typing import Protocol
except ImportError:  # pragma: no cover
    Protocol = object  # type: ignore

PROVIDER_NAME = "google-gemini-api"

# Finish/block reasons that mean the provider refused on safety grounds.
SAFETY_REASONS = frozenset(
    {
        "SAFETY",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "SPII",
        "IMAGE_SAFETY",
        "IMAGE_PROHIBITED_CONTENT",
        "RECITATION",
        "MODEL_ARMOR",
        "JAILBREAK",
        "OTHER_SAFETY",
    }
)


@dataclass(frozen=True)
class ProviderResponse:
    """Provider-neutral view of one model reply."""

    text: Optional[str]
    finish_reason: Optional[str] = None
    block_reason: Optional[str] = None
    usage: Optional[UsageMetadata] = None
    model_version: Optional[str] = None

    def __repr__(self) -> str:
        return "ProviderResponse(finish_reason={!r}, block_reason={!r}, text_chars={})".format(
            self.finish_reason, self.block_reason, len(self.text or "")
        )


class GeminiClient(Protocol):
    """One structured multimodal call. Raise ``LandmarkError`` subclasses."""

    def generate(self, prompt: PromptBundle, *, model: str) -> ProviderResponse:
        ...


class GoogleGenAIClient:
    """Adapter for the official ``google-genai`` SDK (``from google import genai``)."""

    def __init__(self, api_key: str, *, timeout_seconds: float) -> None:
        if not api_key:
            raise ConfigurationError("GEMINI_API_KEY is not set on the server.")
        try:
            from google import genai
            from google.genai import types
        except ImportError:  # pragma: no cover - dependency is declared
            raise ConfigurationError("The google-genai package is not installed.") from None
        self._types = types
        self._client = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(
                timeout=int(timeout_seconds * 1000),  # milliseconds
                retry_options=types.HttpRetryOptions(attempts=1),
            ),
        )

    def __repr__(self) -> str:
        return "GoogleGenAIClient()"

    def _contents(self, prompt: PromptBundle):
        types = self._types
        parts = []
        for part in prompt.parts:
            if part.kind == "text":
                parts.append(types.Part.from_text(text=part.text or ""))
            elif part.kind == "image":
                parts.append(types.Part.from_bytes(data=part.data or b"", mime_type=part.mime_type or ""))
            else:  # pragma: no cover - PromptBundle only builds the two kinds
                raise InvalidRequestError(details=("unknown prompt part kind",))
        return [types.Content(role="user", parts=parts)]

    def generate(self, prompt: PromptBundle, *, model: str) -> ProviderResponse:
        types = self._types
        config = types.GenerateContentConfig(
            system_instruction=prompt.system_instruction,
            response_mime_type="application/json",
            response_json_schema=prompt.response_schema,
            candidate_count=1,
            # No tools, search, URL context, or function calling.
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
        try:
            response = self._client.models.generate_content(
                model=model, contents=self._contents(prompt), config=config
            )
        except LandmarkError:
            raise
        except Exception as exc:  # noqa: BLE001 - translated to typed, safe errors
            raise translate_exception(exc) from None
        return _to_provider_response(response)


def _enum_name(value) -> Optional[str]:
    if value is None:
        return None
    return getattr(value, "name", None) or str(value)


def _to_provider_response(response) -> ProviderResponse:
    block_reason = None
    feedback = getattr(response, "prompt_feedback", None)
    if feedback is not None:
        block_reason = _enum_name(getattr(feedback, "block_reason", None))
    finish_reason = None
    candidates = getattr(response, "candidates", None) or []
    if candidates:
        finish_reason = _enum_name(getattr(candidates[0], "finish_reason", None))
    try:
        text = response.text
    except Exception:  # noqa: BLE001 - text accessor can raise on blocked replies
        text = None
    usage = None
    um = getattr(response, "usage_metadata", None)
    if um is not None:
        usage = UsageMetadata(
            prompt_token_count=getattr(um, "prompt_token_count", None),
            candidates_token_count=getattr(um, "candidates_token_count", None),
            thoughts_token_count=getattr(um, "thoughts_token_count", None),
            total_token_count=getattr(um, "total_token_count", None),
        )
    return ProviderResponse(
        text=text,
        finish_reason=finish_reason,
        block_reason=block_reason,
        usage=usage,
        model_version=getattr(response, "model_version", None),
    )


def translate_exception(exc: BaseException) -> LandmarkError:
    """Map an SDK/transport exception to a typed error without its message."""
    code = getattr(exc, "code", None)
    status = str(getattr(exc, "status", "") or "")
    if isinstance(code, int):
        if code in (401, 403) or status in ("UNAUTHENTICATED", "PERMISSION_DENIED") or (
            code == 400 and _mentions_api_key(exc)
        ):
            return GeminiAuthenticationError(provider_status=code)
        if code == 429 or status == "RESOURCE_EXHAUSTED":
            return GeminiRateLimitedError(provider_status=code)
        if code in (408, 504) or status == "DEADLINE_EXCEEDED":
            return GeminiTimeoutError(provider_status=code)
        if code >= 500:
            return GeminiUnavailableError(provider_status=code)
        if code == 404:
            return GeminiUnavailableError(
                "The configured Gemini model is not available to this API project.",
                provider_status=code,
                retryable=False,
            )
        return InvalidRequestError(
            "Gemini rejected the request.", provider_status=code, details=("provider status " + status,) if status else ()
        )

    name = type(exc).__name__
    if "Timeout" in name:
        return GeminiTimeoutError(details=(name,))
    if name in ("ConnectError", "ConnectTimeout", "NetworkError", "RemoteProtocolError", "ReadError",
                "WriteError", "TransportError", "ConnectionError", "ConnectionResetError"):
        return GeminiUnavailableError(details=(name,))
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return GeminiTimeoutError(details=(name,)) if isinstance(exc, TimeoutError) else GeminiUnavailableError(details=(name,))
    return GeminiUnavailableError("Unexpected provider failure.", details=(name,), retryable=False)


def _mentions_api_key(exc: BaseException) -> bool:
    details = getattr(exc, "details", None)
    try:
        blob = str(details) + " " + str(getattr(exc, "message", ""))
    except Exception:  # noqa: BLE001
        return False
    return "API_KEY" in blob.upper().replace(" ", "_")
