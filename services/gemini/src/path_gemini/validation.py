"""Deterministic input validation, output validation, and fingerprinting.

Error details name indexes, field names, and counts. They never echo image
bytes or model-generated prose.
"""

import hashlib
import json
import re
from typing import Iterable, List, Optional, Sequence, Set

from pydantic import ValidationError

from .errors import (
    ConflictingDirectionError,
    CorruptImageError,
    InvalidModelOutputError,
    InvalidRequestError,
    UnsupportedMediaError,
)
from .models import (
    FRAME_ROLE_ORDER,
    STAIRS_MANEUVERS,
    FrameInput,
    LandmarkCandidate,
    LandmarkRequest,
    LandmarkResponse,
    Maneuver,
    Side,
)
from .prompt import (
    MAX_CANDIDATES,
    MAX_INSTRUCTION_CHARS,
    MAX_LANDMARK_CHARS,
    MAX_REASON_CHARS,
    MAX_VISIBLE_TEXT_CHARS,
)

MIN_FRAMES = 2
MAX_FRAMES = 3
MAX_ID_CHARS = 128
ACCEPTED_MIME_TYPES = ("image/jpeg", "image/png")

_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_URL_RE = re.compile(r"(?i)\b(?:https?|ftp|file|data|gs|s3)\s*:|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|app|dev|ai|co)\b")
_MARKUP_RE = re.compile(r"<[^>]*>|```|\[[^\]]*\]\([^)]*\)")
_WAYPOINT_LIKE_RE = re.compile(r"(?i)\b(?:wp|waypoint|frame|segment|revision)[-_ ]?\d+\b")
_ID_CHARS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")


# ------------------------------------------------------------------ input ---


def detect_image_type(data: bytes) -> str:
    """Return the MIME type the bytes actually contain, or ``""``."""
    if data.startswith(_JPEG_MAGIC) and len(data) > 4:
        return "image/jpeg"
    if data.startswith(_PNG_MAGIC) and len(data) > 24 and data[12:16] == b"IHDR":
        return "image/png"
    return ""


def _check_id(value: str, name: str, problems: List[str]) -> None:
    if not isinstance(value, str) or not value.strip():
        problems.append("{} is empty".format(name))
    elif len(value) > MAX_ID_CHARS:
        problems.append("{} is longer than {} characters".format(name, MAX_ID_CHARS))
    elif not _ID_CHARS_RE.match(value) or _URL_RE.search(value):
        problems.append("{} must be an opaque identifier, not a URL or free text".format(name))


def ordered_frames(request: LandmarkRequest) -> List[FrameInput]:
    """Frames in canonical walking order: approach, junction, exit."""
    rank = {role: i for i, role in enumerate(FRAME_ROLE_ORDER)}
    return sorted(request.frames, key=lambda f: rank[f.role])


def validate_request(request: LandmarkRequest, max_image_bytes: int) -> List[FrameInput]:
    """Reject structurally invalid requests before any provider call.

    Returns the frames in canonical order. Sam still owns checking that these
    IDs exist and belong to the same scan revision.
    """
    problems: List[str] = []
    _check_id(request.request_id, "requestId", problems)
    _check_id(request.scan_revision_id, "scanRevisionId", problems)
    _check_id(request.route_segment_id, "routeSegmentId", problems)
    _check_id(request.approach_direction_id, "approachDirectionId", problems)
    wp = request.waypoints
    if wp is not None:
        _check_id(wp.approach_waypoint_id, "waypoints.approachWaypointId", problems)
        _check_id(wp.junction_waypoint_id, "waypoints.junctionWaypointId", problems)
        _check_id(wp.exit_waypoint_id, "waypoints.exitWaypointId", problems)
        if len({wp.approach_waypoint_id, wp.junction_waypoint_id, wp.exit_waypoint_id}) != 3:
            problems.append("approach, junction, and exit waypoint IDs must differ")
    movement = request.verified_movement
    if movement.side is not None and movement.maneuver not in STAIRS_MANEUVERS:
        problems.append("verifiedMovement.side is only allowed for stairs_up or stairs_down")
    if request.verified_movement.instruction is not None:
        text = request.verified_movement.instruction
        if not text.strip() or len(text) > MAX_INSTRUCTION_CHARS or _URL_RE.search(text):
            problems.append("verifiedMovement.instruction must be short plain text")

    count = len(request.frames)
    if not MIN_FRAMES <= count <= MAX_FRAMES:
        problems.append("expected {} to {} frames, got {}".format(MIN_FRAMES, MAX_FRAMES, count))

    seen_ids: Set[str] = set()
    seen_roles: Set[str] = set()
    for i, frame in enumerate(request.frames):
        _check_id(frame.frame_id, "frames[{}].frameId".format(i), problems)
        if frame.frame_id in seen_ids:
            problems.append("frames[{}].frameId is a duplicate".format(i))
        seen_ids.add(frame.frame_id)
        if frame.role in seen_roles:
            problems.append("frames[{}].role {} is a duplicate".format(i, frame.role.value))
        seen_roles.add(frame.role)
        if frame.timestamp_seconds is not None and frame.timestamp_seconds < 0:
            problems.append("frames[{}].timestampSeconds is negative".format(i))
    if problems:
        raise InvalidRequestError(details=tuple(problems))

    for i, frame in enumerate(request.frames):
        if frame.mime_type not in ACCEPTED_MIME_TYPES:
            raise UnsupportedMediaError(details=("frames[{}].mimeType is not image/jpeg or image/png".format(i),))
    for i, frame in enumerate(request.frames):
        size = len(frame.image_bytes)
        if size == 0:
            raise InvalidRequestError(details=("frames[{}].imageBytes is empty".format(i),))
        if size > max_image_bytes:
            raise InvalidRequestError(
                details=("frames[{}].imageBytes is {} bytes; limit is {}".format(i, size, max_image_bytes),)
            )
        if detect_image_type(frame.image_bytes) != frame.mime_type:
            raise CorruptImageError(details=("frames[{}] bytes are not a valid {}".format(i, frame.mime_type),))

    return ordered_frames(request)


# ----------------------------------------------------------- fingerprint ---


def fingerprint_fields(request: LandmarkRequest, model: str, prompt_version: str) -> dict:
    return {
        "scanRevisionId": request.scan_revision_id,
        "routeSegmentId": request.route_segment_id,
        "approachDirectionId": request.approach_direction_id,
        "maneuver": request.verified_movement.maneuver.value,
        "side": request.verified_movement.side.value if request.verified_movement.side else None,
        "frameIds": [f.frame_id for f in ordered_frames(request)],
        "promptVersion": prompt_version,
        "model": model,
    }


def compute_fingerprint(request: LandmarkRequest, model: str, prompt_version: str) -> str:
    """Deterministic idempotency key for Sam's job cache (``sha256:<hex>``)."""
    canonical = json.dumps(
        fingerprint_fields(request, model, prompt_version), sort_keys=True, separators=(",", ":")
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# --------------------------------------------------------- maneuver text ---

# Phrase families detected in a guest instruction. Slight/U-turn families are
# matched and removed first so "bear left" is not also counted as a plain left.
_STAIRS = r"(?:stairs|steps|staircase|stairway)"
_FAMILY_PATTERNS = (
    ("stairs_up", re.compile(r"\b(?:take|go|walk|head|climb)\s+(?:up\s+)?(?:the\s+)?" + _STAIRS + r"\s+up\b"
                             r"|\b(?:go|walk|head|climb)\s+up\s+(?:the\s+)?" + _STAIRS + r"\b|\bupstairs\b")),
    ("stairs_down", re.compile(r"\b(?:take|go|walk|head)\s+(?:the\s+)?" + _STAIRS + r"\s+down\b"
                               r"|\b(?:go|walk|head)\s+down\s+(?:the\s+)?" + _STAIRS + r"\b|\bdownstairs\b")),
    ("slight_left", re.compile(r"\b(?:bear|veer|keep|slight|slightly)\s+(?:to\s+(?:the|your)\s+)?left\b|\bslight\s+left\b")),
    ("slight_right", re.compile(r"\b(?:bear|veer|keep|slight|slightly)\s+(?:to\s+(?:the|your)\s+)?right\b|\bslight\s+right\b")),
    ("u_turn", re.compile(r"\bu[\s-]?turn\b|\bturn\s+(?:around|back)\b|\bgo\s+back\b|\bdouble\s+back\b")),
    ("arrive", re.compile(r"\barriv(?:e|ed|ing|al)\b|\bdestination\b|\byou(?:'ve| have)\s+(?:arrived|reached)\b")),
    ("left", re.compile(r"\bleft\b")),
    ("right", re.compile(r"\bright\b")),
    ("straight", re.compile(r"\bstraight\b|\b(?:continue|keep\s+going|go|walk|head)\s+(?:ahead|forward|on)\b")),
)

# Which detected families each verified maneuver accepts. Arrival may mention a
# side ("on your left") because it has no turn of its own.
ALLOWED_FAMILIES = {
    Maneuver.LEFT: {"left"},
    Maneuver.RIGHT: {"right"},
    Maneuver.STRAIGHT: {"straight"},
    Maneuver.SLIGHT_LEFT: {"slight_left"},
    Maneuver.SLIGHT_RIGHT: {"slight_right"},
    Maneuver.U_TURN: {"u_turn"},
    Maneuver.ARRIVE: {"arrive", "left", "right"},
    # A side word is allowed only when the verified side says so (see below).
    Maneuver.STAIRS_UP: {"stairs_up"},
    Maneuver.STAIRS_DOWN: {"stairs_down"},
}
REQUIRED_FAMILY = {
    Maneuver.LEFT: "left",
    Maneuver.RIGHT: "right",
    Maneuver.STRAIGHT: "straight",
    Maneuver.SLIGHT_LEFT: "slight_left",
    Maneuver.SLIGHT_RIGHT: "slight_right",
    Maneuver.U_TURN: "u_turn",
    Maneuver.ARRIVE: "arrive",
    Maneuver.STAIRS_UP: "stairs_up",
    Maneuver.STAIRS_DOWN: "stairs_down",
}


def detect_maneuver_families(instruction: str) -> Set[str]:
    text = " " + instruction.lower().replace("’", "'") + " "
    found: Set[str] = set()
    for name, pattern in _FAMILY_PATTERNS:
        if pattern.search(text):
            found.add(name)
            text = pattern.sub(" ", text)
    return found


def check_instruction_maneuver(instruction: str, maneuver: Maneuver, side: Optional[Side] = None) -> None:
    found = detect_maneuver_families(instruction)
    allowed = set(ALLOWED_FAMILIES[maneuver])
    if maneuver in STAIRS_MANEUVERS and side is not None:
        allowed.add(side.value)
    conflicts = found - allowed
    if conflicts:
        raise ConflictingDirectionError(
            details=("instruction mentions {} but verified maneuver is {}".format(
                ", ".join(sorted(conflicts)), maneuver.value),)
        )
    if REQUIRED_FAMILY[maneuver] not in found:
        raise InvalidModelOutputError(
            details=("instruction does not use the verified maneuver {}".format(maneuver.value),)
        )


# ---------------------------------------------------------------- output ---


def parse_model_output(text: str) -> LandmarkResponse:
    if text is None or not text.strip():
        raise InvalidModelOutputError(details=("empty response",))
    try:
        payload = json.loads(text)
    except ValueError:
        raise InvalidModelOutputError(details=("response is not valid JSON",)) from None
    if not isinstance(payload, dict):
        raise InvalidModelOutputError(details=("response is not a JSON object",))
    try:
        return LandmarkResponse.model_validate(payload)
    except ValidationError as exc:
        locs = sorted({".".join(str(p) for p in err["loc"]) or "<root>" for err in exc.errors()})
        raise InvalidModelOutputError(details=tuple("schema error at " + loc for loc in locs[:8])) from None


def _has_unsafe_content(value: str, forbidden_ids: Iterable[str]) -> bool:
    if _URL_RE.search(value) or _MARKUP_RE.search(value) or _WAYPOINT_LIKE_RE.search(value):
        return True
    lowered = value.lower()
    return any(ident and ident.lower() in lowered for ident in forbidden_ids)


def _check_candidate(
    i: int, cand: LandmarkCandidate, frame_ids: Sequence[str], forbidden_ids: Sequence[str]
) -> List[str]:
    p: List[str] = []
    prefix = "candidates[{}]".format(i)
    landmark = cand.landmark.strip()
    instruction = cand.instruction.strip()
    if not landmark:
        p.append(prefix + ".landmark is empty")
    elif len(landmark) > MAX_LANDMARK_CHARS:
        p.append(prefix + ".landmark exceeds {} characters".format(MAX_LANDMARK_CHARS))
    if not instruction:
        p.append(prefix + ".instruction is empty")
    elif len(instruction) > MAX_INSTRUCTION_CHARS:
        p.append(prefix + ".instruction exceeds {} characters".format(MAX_INSTRUCTION_CHARS))
    if cand.visible_text is not None:
        vt = cand.visible_text.strip()
        if not vt:
            p.append(prefix + ".visibleText is blank; use null")
        elif len(vt) > MAX_VISIBLE_TEXT_CHARS:
            p.append(prefix + ".visibleText exceeds {} characters".format(MAX_VISIBLE_TEXT_CHARS))
    if cand.reason is not None and len(cand.reason.strip()) > MAX_REASON_CHARS:
        p.append(prefix + ".reason exceeds {} characters".format(MAX_REASON_CHARS))
    if not cand.source_frame_ids:
        p.append(prefix + ".sourceFrameIds is empty")
    if len(set(cand.source_frame_ids)) != len(cand.source_frame_ids):
        p.append(prefix + ".sourceFrameIds has duplicates")
    unknown = [fid for fid in cand.source_frame_ids if fid not in frame_ids]
    if unknown:
        p.append(prefix + ".sourceFrameIds references {} unknown frame ID(s)".format(len(unknown)))
    guest_fields = [("landmark", landmark), ("instruction", instruction)]
    other_fields = [("visibleText", cand.visible_text or ""), ("reason", cand.reason or "")]
    for name, value in guest_fields:
        if value and _has_unsafe_content(value, forbidden_ids):
            p.append(prefix + "." + name + " contains a URL, markup, or internal identifier")
    for name, value in other_fields:
        if value and (_URL_RE.search(value) or _MARKUP_RE.search(value)):
            p.append(prefix + "." + name + " contains a URL or markup")
    return p


def validate_model_output(response: LandmarkResponse, request: LandmarkRequest) -> LandmarkResponse:
    """Enforce every post-response rule. Rejects the whole response on failure.

    Raises ``ConflictingDirectionError`` if any candidate changes the verified
    maneuver; a safe failure is preferred over silently rewriting it.
    """
    frame_ids = [f.frame_id for f in request.frames]
    wp = request.waypoints
    waypoint_ids = [] if wp is None else [wp.approach_waypoint_id, wp.junction_waypoint_id, wp.exit_waypoint_id]
    forbidden_ids = waypoint_ids + [
        request.route_segment_id,
        request.scan_revision_id,
        request.approach_direction_id,
    ] + frame_ids

    problems: List[str] = []
    if len(response.candidates) > MAX_CANDIDATES:
        problems.append("{} candidates; at most {} allowed".format(len(response.candidates), MAX_CANDIDATES))
    reason = (response.abstention_reason or "").strip()
    if response.abstained:
        if response.candidates:
            problems.append("abstained is true but candidates were returned")
        if not reason:
            problems.append("abstained is true but abstentionReason is empty")
        elif len(reason) > MAX_REASON_CHARS:
            problems.append("abstentionReason exceeds {} characters".format(MAX_REASON_CHARS))
        elif _URL_RE.search(reason) or _MARKUP_RE.search(reason):
            problems.append("abstentionReason contains a URL or markup")
    else:
        if not response.candidates:
            problems.append("candidates is empty but abstained is false")
        if response.abstention_reason is not None and reason:
            problems.append("abstentionReason is set but abstained is false")
    for i, cand in enumerate(response.candidates):
        problems.extend(_check_candidate(i, cand, frame_ids, forbidden_ids))
    if problems:
        raise InvalidModelOutputError(details=tuple(problems))

    maneuver = request.verified_movement.maneuver
    side = request.verified_movement.side
    for cand in response.candidates:
        check_instruction_maneuver(cand.instruction, maneuver, side)
    return response
