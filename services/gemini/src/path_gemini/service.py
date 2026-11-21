"""Orchestration: validate -> prompt -> provider (with retries) -> validate -> result."""

import logging
import random
import time
from typing import Callable, Optional

from .client import PROVIDER_NAME, SAFETY_REASONS, GeminiClient, GoogleGenAIClient, ProviderResponse
from .config import GeminiConfig
from .errors import GeminiSafetyBlockError, InvalidModelOutputError, LandmarkError
from .models import LandmarkGenerationResult, LandmarkRequest, ResultCategory
from .prompt import PROMPT_VERSION, build_prompt
from .telemetry import TelemetryRecord, emit
from .validation import compute_fingerprint, parse_model_output, validate_model_output, validate_request

BACKOFF_BASE_SECONDS = 0.5
BACKOFF_MAX_SECONDS = 8.0


class LandmarkService:
    """Reusable service. Inject ``client`` (and timing hooks) in tests."""

    def __init__(
        self,
        config: GeminiConfig,
        client: Optional[GeminiClient] = None,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        jitter: Callable[[], float] = random.random,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self.config = config
        self.client = client if client is not None else GoogleGenAIClient(
            config.api_key, timeout_seconds=config.timeout_seconds
        )
        self._sleep = sleep
        self._clock = clock
        self._jitter = jitter
        self._logger = logger

    def __repr__(self) -> str:
        return "LandmarkService(model={!r})".format(self.config.model)

    def backoff_seconds(self, retry_index: int) -> float:
        """Exponential backoff with jitter: base * 2^n * [0.5, 1.5), capped."""
        delay = BACKOFF_BASE_SECONDS * (2 ** retry_index) * (0.5 + self._jitter())
        return min(delay, BACKOFF_MAX_SECONDS)

    def propose_landmarks(self, request: LandmarkRequest) -> LandmarkGenerationResult:
        """Return validated draft candidates or an explicit abstention.

        Raises a ``LandmarkError`` subclass on invalid input, provider failure,
        or invalid/conflicting model output. Abstention is not an error.
        """
        started = self._clock()
        attempts = 0
        model = self.config.model
        try:
            frames = validate_request(request, self.config.max_image_bytes)
            prompt = build_prompt(request, frames)
            reply: Optional[ProviderResponse] = None
            while True:
                attempts += 1
                try:
                    reply = self.client.generate(prompt, model=model)
                    break
                except LandmarkError as exc:
                    if exc.retryable and attempts <= self.config.max_retries:
                        self._sleep(self.backoff_seconds(attempts - 1))
                        continue
                    raise
            _raise_if_blocked(reply)
            parsed = validate_model_output(parse_model_output(reply.text), request)
        except LandmarkError as exc:
            exc.request_id = getattr(request, "request_id", None)
            exc.attempts = attempts
            self._log(request, started, attempts, exc.code.value, error=exc)
            raise

        elapsed_ms = self._elapsed_ms(started)
        category = ResultCategory.NO_CLEAR_LANDMARK if parsed.abstained else ResultCategory.CANDIDATES
        result = LandmarkGenerationResult(
            request_id=request.request_id,
            scan_revision_id=request.scan_revision_id,
            route_segment_id=request.route_segment_id,
            approach_direction_id=request.approach_direction_id,
            maneuver=request.verified_movement.maneuver,
            frame_ids=[f.frame_id for f in frames],
            category=category,
            candidates=list(parsed.candidates),
            abstained=parsed.abstained,
            abstention_reason=(parsed.abstention_reason or "").strip() or None,
            provider=PROVIDER_NAME,
            model=model,
            model_version=reply.model_version,
            prompt_version=PROMPT_VERSION,
            elapsed_ms=elapsed_ms,
            attempts=attempts,
            usage=reply.usage,
            fingerprint=compute_fingerprint(request, model, PROMPT_VERSION),
            raw_response_text=reply.text,
        )
        self._log(request, started, attempts, category.value, candidate_count=len(result.candidates))
        return result

    def _elapsed_ms(self, started: float) -> int:
        return max(0, int(round((self._clock() - started) * 1000)))

    def _log(self, request, started, attempts, category, *, error=None, candidate_count=None) -> None:
        emit(
            TelemetryRecord(
                request_id=getattr(request, "request_id", None),
                scan_revision_id=getattr(request, "scan_revision_id", None),
                route_segment_id=getattr(request, "route_segment_id", None),
                approach_direction_id=getattr(request, "approach_direction_id", None),
                frame_count=len(getattr(request, "frames", []) or []),
                model=self.config.model,
                prompt_version=PROMPT_VERSION,
                elapsed_ms=self._elapsed_ms(started),
                attempts=attempts,
                retry_count=max(0, attempts - 1),
                result_category=category,
                error_category=error.code.value if error is not None else None,
                provider_status=error.provider_status if error is not None else None,
                candidate_count=candidate_count,
            ),
            self._logger,
        )


def _raise_if_blocked(reply: Optional[ProviderResponse]) -> None:
    if reply is None:
        raise InvalidModelOutputError(details=("no provider response",))
    for reason in (reply.block_reason, reply.finish_reason):
        if reason and reason.upper() in SAFETY_REASONS:
            raise GeminiSafetyBlockError(details=("provider reason " + reason.upper(),))
    if reply.finish_reason and reply.finish_reason.upper() == "MAX_TOKENS":
        raise InvalidModelOutputError(details=("response was truncated",))


_default_service: Optional[LandmarkService] = None


def propose_landmarks(request: LandmarkRequest) -> LandmarkGenerationResult:
    """Return validated draft candidates or an explicit abstention.

    Uses a process-wide service configured from environment variables. Sam can
    instead construct ``LandmarkService(GeminiConfig.from_env())`` and reuse it.
    """
    global _default_service
    if _default_service is None:
        _default_service = LandmarkService(GeminiConfig.from_env())
    return _default_service.propose_landmarks(request)
