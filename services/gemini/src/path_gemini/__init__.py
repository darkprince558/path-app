"""Gemini landmark assistant for Path App.

Gemini proposes visible landmark wording for a turn the route graph has
already verified. Every result is a draft that needs organizer approval.
"""

from .client import PROVIDER_NAME, GeminiClient, GoogleGenAIClient, ProviderResponse
from .config import GeminiConfig
from .errors import (
    ConfigurationError,
    ConflictingDirectionError,
    CorruptImageError,
    ErrorCode,
    GeminiAuthenticationError,
    GeminiRateLimitedError,
    GeminiSafetyBlockError,
    GeminiTimeoutError,
    GeminiUnavailableError,
    InvalidModelOutputError,
    InvalidRequestError,
    LandmarkError,
    UnsupportedMediaError,
)
from .models import (
    FrameInput,
    FrameRole,
    LandmarkCandidate,
    LandmarkGenerationResult,
    LandmarkRequest,
    LandmarkResponse,
    Maneuver,
    ResultCategory,
    UsageMetadata,
    VerifiedMovement,
    Visibility,
    Waypoints,
)
from .prompt import PROMPT_VERSION
from .service import LandmarkService, propose_landmarks
from .validation import compute_fingerprint, fingerprint_fields

__all__ = [
    "PROMPT_VERSION",
    "PROVIDER_NAME",
    "ConfigurationError",
    "ConflictingDirectionError",
    "CorruptImageError",
    "ErrorCode",
    "FrameInput",
    "FrameRole",
    "GeminiAuthenticationError",
    "GeminiClient",
    "GeminiConfig",
    "GeminiRateLimitedError",
    "GeminiSafetyBlockError",
    "GeminiTimeoutError",
    "GeminiUnavailableError",
    "GoogleGenAIClient",
    "InvalidModelOutputError",
    "InvalidRequestError",
    "LandmarkCandidate",
    "LandmarkError",
    "LandmarkGenerationResult",
    "LandmarkRequest",
    "LandmarkResponse",
    "LandmarkService",
    "Maneuver",
    "ProviderResponse",
    "ResultCategory",
    "UnsupportedMediaError",
    "UsageMetadata",
    "VerifiedMovement",
    "Visibility",
    "Waypoints",
    "compute_fingerprint",
    "fingerprint_fields",
    "propose_landmarks",
]
