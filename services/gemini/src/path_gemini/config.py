"""Server-side configuration read from environment variables.

The API key is never printed: it is excluded from ``repr`` and never placed in
an error message.
"""

import os
from dataclasses import dataclass, field
from typing import Mapping, Optional

from .errors import ConfigurationError

# Default only; override with GEMINI_MODEL. The README records the model that
# the live approved-fixture test actually ran against.
DEFAULT_MODEL = "gemini-3.6-flash"
DEFAULT_TIMEOUT_SECONDS = 90.0
DEFAULT_MAX_RETRIES = 2
MAX_ALLOWED_RETRIES = 5
DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024  # per frame; three frames stay under Gemini's inline limit


@dataclass(frozen=True)
class GeminiConfig:
    api_key: str = field(repr=False)
    model: str = DEFAULT_MODEL
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    max_retries: int = DEFAULT_MAX_RETRIES
    max_image_bytes: int = DEFAULT_MAX_IMAGE_BYTES

    def __post_init__(self) -> None:
        if not isinstance(self.model, str) or not self.model.strip():
            raise ConfigurationError("GEMINI_MODEL must be a non-empty model ID.")
        if not (0 < self.timeout_seconds <= 600):
            raise ConfigurationError("GEMINI_TIMEOUT_SECONDS must be between 0 and 600.")
        if not (0 <= self.max_retries <= MAX_ALLOWED_RETRIES):
            raise ConfigurationError(
                "GEMINI_MAX_RETRIES must be between 0 and {}.".format(MAX_ALLOWED_RETRIES)
            )
        if self.max_image_bytes <= 0:
            raise ConfigurationError("GEMINI_MAX_IMAGE_BYTES must be positive.")

    @classmethod
    def from_env(cls, environ: Optional[Mapping[str, str]] = None) -> "GeminiConfig":
        env = os.environ if environ is None else environ
        api_key = (env.get("GEMINI_API_KEY") or "").strip()
        if not api_key:
            raise ConfigurationError("GEMINI_API_KEY is not set on the server.")
        return cls(
            api_key=api_key,
            model=(env.get("GEMINI_MODEL") or DEFAULT_MODEL).strip(),
            timeout_seconds=_number(env, "GEMINI_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS, float),
            max_retries=_number(env, "GEMINI_MAX_RETRIES", DEFAULT_MAX_RETRIES, int),
            max_image_bytes=_number(env, "GEMINI_MAX_IMAGE_BYTES", DEFAULT_MAX_IMAGE_BYTES, int),
        )


def _number(env: Mapping[str, str], name: str, default, kind):
    raw = env.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return kind(raw.strip())
    except ValueError:
        raise ConfigurationError("{} must be a {}.".format(name, kind.__name__)) from None
