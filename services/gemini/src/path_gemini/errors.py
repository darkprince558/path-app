"""Typed failures for the landmark assistant.

Every message here is a fixed, safe sentence. Errors never carry image bytes,
base64, API keys, prompt text, provider response bodies, or SDK exception text.
Provider exceptions are re-raised ``from None`` so a logged traceback does not
chain the SDK's original message either.
"""

from enum import Enum
from typing import Optional, Tuple


class ErrorCode(str, Enum):
    INVALID_REQUEST = "INVALID_REQUEST"
    UNSUPPORTED_MEDIA = "UNSUPPORTED_MEDIA"
    CORRUPT_IMAGE = "CORRUPT_IMAGE"
    CONFIGURATION_INVALID = "CONFIGURATION_INVALID"
    GEMINI_AUTHENTICATION_FAILED = "GEMINI_AUTHENTICATION_FAILED"
    GEMINI_RATE_LIMITED = "GEMINI_RATE_LIMITED"
    GEMINI_UNAVAILABLE = "GEMINI_UNAVAILABLE"
    GEMINI_TIMEOUT = "GEMINI_TIMEOUT"
    GEMINI_SAFETY_BLOCK = "GEMINI_SAFETY_BLOCK"
    INVALID_MODEL_OUTPUT = "INVALID_MODEL_OUTPUT"
    CONFLICTING_DIRECTION = "CONFLICTING_DIRECTION"
    # NO_CLEAR_LANDMARK is a *successful* result category (see
    # models.ResultCategory), never raised. It is listed here so Sam can use one
    # vocabulary for every outcome.
    NO_CLEAR_LANDMARK = "NO_CLEAR_LANDMARK"


class LandmarkError(Exception):
    """Base class. ``code`` is stable; ``details`` are short safe strings."""

    code: ErrorCode = ErrorCode.INVALID_REQUEST
    default_message = "Landmark generation failed."
    default_retryable = False

    def __init__(
        self,
        message: Optional[str] = None,
        *,
        details: Tuple[str, ...] = (),
        retryable: Optional[bool] = None,
        provider_status: Optional[int] = None,
    ) -> None:
        self.message = message or self.default_message
        self.details = tuple(details)
        self.retryable = self.default_retryable if retryable is None else retryable
        self.provider_status = provider_status
        # Filled in by the service so Sam can correlate a failure.
        self.request_id: Optional[str] = None
        self.attempts: int = 0
        super().__init__(self.message)

    def __str__(self) -> str:
        if self.details:
            return "{}: {} ({})".format(self.code.value, self.message, "; ".join(self.details))
        return "{}: {}".format(self.code.value, self.message)

    def to_dict(self) -> dict:
        """Safe, JSON-serializable form for persistence as a failed draft."""
        return {
            "code": self.code.value,
            "message": self.message,
            "details": list(self.details),
            "retryable": self.retryable,
            "providerStatus": self.provider_status,
            "requestId": self.request_id,
            "attempts": self.attempts,
        }


class InvalidRequestError(LandmarkError):
    code = ErrorCode.INVALID_REQUEST
    default_message = "The landmark request is invalid."


class UnsupportedMediaError(LandmarkError):
    code = ErrorCode.UNSUPPORTED_MEDIA
    default_message = "Only image/jpeg and image/png frames are accepted."


class CorruptImageError(LandmarkError):
    code = ErrorCode.CORRUPT_IMAGE
    default_message = "A frame's bytes do not match its declared image type."


class ConfigurationError(LandmarkError):
    code = ErrorCode.CONFIGURATION_INVALID
    default_message = "The Gemini configuration is invalid."


class GeminiAuthenticationError(LandmarkError):
    code = ErrorCode.GEMINI_AUTHENTICATION_FAILED
    default_message = "Gemini rejected the API credentials."


class GeminiRateLimitedError(LandmarkError):
    code = ErrorCode.GEMINI_RATE_LIMITED
    default_message = "Gemini rate limit or quota exceeded."
    default_retryable = True


class GeminiUnavailableError(LandmarkError):
    code = ErrorCode.GEMINI_UNAVAILABLE
    default_message = "Gemini is unavailable."
    default_retryable = True


class GeminiTimeoutError(LandmarkError):
    code = ErrorCode.GEMINI_TIMEOUT
    default_message = "The Gemini request timed out."
    default_retryable = True


class GeminiSafetyBlockError(LandmarkError):
    code = ErrorCode.GEMINI_SAFETY_BLOCK
    default_message = "Gemini declined to answer for safety reasons."


class InvalidModelOutputError(LandmarkError):
    code = ErrorCode.INVALID_MODEL_OUTPUT
    default_message = "Gemini returned output that failed validation."


class ConflictingDirectionError(LandmarkError):
    code = ErrorCode.CONFLICTING_DIRECTION
    default_message = "Gemini's instruction conflicts with the verified maneuver."
