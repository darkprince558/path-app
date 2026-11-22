"""Typed request, model-output, and result models.

Wire names are camelCase (``frameId``) to match the team's JSON contracts;
Python attributes are snake_case. Both spellings are accepted on input.

Image bytes are excluded from ``repr`` and from ``model_dump``/JSON output, and
every model hides input values in Pydantic validation errors, so a bad request
cannot leak bytes into an exception message.
"""

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class _Base(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        hide_input_in_errors=True,
        frozen=True,
        extra="forbid",
    )


class Maneuver(str, Enum):
    """The verified movement at the junction. Gemini may never change it."""

    LEFT = "left"
    RIGHT = "right"
    STRAIGHT = "straight"
    SLIGHT_LEFT = "slight_left"
    SLIGHT_RIGHT = "slight_right"
    U_TURN = "u_turn"
    ARRIVE = "arrive"
    STAIRS_UP = "stairs_up"
    STAIRS_DOWN = "stairs_down"


STAIRS_MANEUVERS = (Maneuver.STAIRS_UP, Maneuver.STAIRS_DOWN)


class Side(str, Enum):
    """Which way the walker turns into the stairs (stairs maneuvers only)."""

    LEFT = "left"
    RIGHT = "right"


class LandmarkType(str, Enum):
    SIGN = "sign"
    DOOR = "door"
    ARTWORK = "artwork"
    WINDOW = "window"
    STAIRS = "stairs"
    ELEVATOR = "elevator"
    FURNITURE = "furniture"
    FIXTURE = "fixture"
    ROOM_ENTRANCE = "room_entrance"
    ARCHITECTURE = "architecture"
    OTHER = "other"


class FrameRole(str, Enum):
    """Where a frame sits along the approach. Prompt order follows this order."""

    APPROACH = "approach"
    JUNCTION = "junction"
    EXIT = "exit"


FRAME_ROLE_ORDER = (FrameRole.APPROACH, FrameRole.JUNCTION, FrameRole.EXIT)


class Visibility(str, Enum):
    CLEAR = "clear"
    PARTIAL = "partial"
    UNCERTAIN = "uncertain"


class ResultCategory(str, Enum):
    """Successful outcomes. Failures are raised as ``LandmarkError``."""

    CANDIDATES = "CANDIDATES"
    NO_CLEAR_LANDMARK = "NO_CLEAR_LANDMARK"


# ---------------------------------------------------------------- request ---


class FrameInput(_Base):
    """One selected RGB frame, already authorized and loaded by Sam's backend."""

    frame_id: str
    role: FrameRole
    mime_type: str
    image_bytes: bytes = Field(repr=False, exclude=True, strict=True)
    timestamp_seconds: Optional[float] = None


class Waypoints(_Base):
    approach_waypoint_id: str
    junction_waypoint_id: str
    exit_waypoint_id: str


class VerifiedMovement(_Base):
    maneuver: Maneuver
    # Stairs only: the walker turns left/right into the stairs. None = straight on.
    side: Optional[Side] = None
    # Optional backend wording, e.g. "Turn left at the junction". Trusted text.
    instruction: Optional[str] = None


class LandmarkRequest(_Base):
    request_id: str
    scan_revision_id: str
    route_segment_id: str
    approach_direction_id: str
    # Named graph waypoints, when the route has them. NavMesh routes have only
    # corners, so this is optional; the turn is then identified by segment ID.
    waypoints: Optional[Waypoints] = None
    verified_movement: VerifiedMovement
    frames: List[FrameInput]


# ----------------------------------------------------------- model output ---


class LandmarkCandidate(_Base):
    landmark: str
    landmark_type: LandmarkType
    visible_text: Optional[str] = None
    source_frame_ids: List[str]
    instruction: str
    visibility: Visibility
    reason: Optional[str] = None


class LandmarkResponse(_Base):
    """The normalized JSON object Gemini must return."""

    candidates: List[LandmarkCandidate]
    abstained: bool
    abstention_reason: Optional[str] = None


# ----------------------------------------------------------------- result ---


class UsageMetadata(_Base):
    prompt_token_count: Optional[int] = None
    candidates_token_count: Optional[int] = None
    thoughts_token_count: Optional[int] = None
    total_token_count: Optional[int] = None


class LandmarkGenerationResult(_Base):
    """A validated draft set or a successful abstention, plus safe metadata.

    Every candidate is a *draft* that needs organizer approval before a guest
    may see it. ``raw_response_text`` is the provider's JSON text, kept for a
    restricted audit field; it is omitted from ``repr``.
    """

    request_id: str
    scan_revision_id: str
    route_segment_id: str
    approach_direction_id: str
    maneuver: Maneuver
    side: Optional[Side] = None
    frame_ids: List[str]
    category: ResultCategory
    candidates: List[LandmarkCandidate]
    abstained: bool
    abstention_reason: Optional[str] = None
    requires_review: bool = True
    provider: str
    model: str
    model_version: Optional[str] = None
    prompt_version: str
    elapsed_ms: int
    attempts: int
    usage: Optional[UsageMetadata] = None
    fingerprint: str
    raw_response_text: Optional[str] = Field(default=None, repr=False)
