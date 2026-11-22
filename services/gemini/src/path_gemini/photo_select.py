"""Pick the 2-3 capture photos that best show one turn.

Each photo in Anish's ``frames.json`` has a camera pose (``cameraToWorld`` or
``cameraPose``: 16 numbers, column-major). From it we know where the camera
was (column 4) and which way it looked (ARKit cameras look along -Z, so the
negated column 3).

For a turn at position P, walked in direction ``incoming`` and left along
``outgoing``, we want:

    approach   2.5-10 m before P, facing the incoming direction (ideal 5 m)
    junction   up to 2.5 m before P, facing the incoming direction (ideal 1 m)
    exit       0.5-6 m after P, facing the outgoing direction (ideal 2 m)

Each photo must also be within 2 m of the walking line, face within 50
degrees of the walking direction, have normal tracking, and be on roughly
the same floor: camera height minus 1.4 m eye height within 1 m of the turn's
floor point (the exit may be up to 5 m lower or higher, for stairs).

Camera poses are in the capture's own frame. If that differs from the space
frame the route uses, pass ``capture_to_space`` (16 numbers, column-major),
normally the scan's ``transform``. Ask Sam/Anish to confirm which applies.
"""

import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

Vec3 = Tuple[float, float, float]
Vec2 = Tuple[float, float]

ROLES = {
    # role: (min along, max along, ideal along, uses outgoing direction)
    "approach": (-10.0, -2.5, -5.0, False),
    "junction": (-2.5, 0.5, -1.0, False),
    "exit": (0.5, 6.0, 2.0, True),
}
MAX_LATERAL_M = 2.0
MAX_FACING_DEG = 50.0
EYE_HEIGHT_M = 1.4  # phones are held about this high; route points are on the floor
MAX_FLOOR_DIFF_M = 1.0
MAX_STAIRS_DIFF_M = 5.0


class FrameSelectError(ValueError):
    pass


@dataclass(frozen=True)
class CameraFrame:
    frame_id: str
    position: Vec3
    forward: Vec2  # unit, floor plane (x, z)
    timestamp_seconds: Optional[float]


def _matrix(values, name: str) -> List[float]:
    try:
        m = [float(v) for v in values]
    except (TypeError, ValueError):
        raise FrameSelectError("{} must be 16 numbers".format(name)) from None
    if len(m) != 16 or not all(math.isfinite(v) for v in m):
        raise FrameSelectError("{} must be 16 finite numbers".format(name))
    return m


def _apply(m: List[float], v: Vec3, w: float) -> Vec3:
    """Column-major 4x4 times (v, w)."""
    return (
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * w,
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * w,
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * w,
    )


def parse_frames(frames: Sequence[dict], capture_to_space: Optional[Sequence[float]] = None) -> List[CameraFrame]:
    """Read frames.json entries (Anish's or Sam's spelling). Skips unusable ones."""
    transform = _matrix(capture_to_space, "captureToSpace") if capture_to_space is not None else None
    out: List[CameraFrame] = []
    for i, f in enumerate(frames):
        if not isinstance(f, dict):
            raise FrameSelectError("frame {} must be an object".format(i))
        frame_id = f.get("frameId") or f.get("id")
        if not isinstance(frame_id, str) or not frame_id:
            raise FrameSelectError("frame {} needs a frameId or id".format(i))
        tracking = f.get("trackingState")
        if tracking not in (None, "normal"):
            continue  # poor tracking: position may be wrong
        pose = f.get("cameraToWorld", f.get("cameraPose"))
        if pose is None:
            continue
        m = _matrix(pose, "frame {} pose".format(frame_id))
        pos = (m[12], m[13], m[14])
        fwd = (-m[8], -m[9], -m[10])
        if transform is not None:
            pos = _apply(transform, pos, 1.0)
            fwd = _apply(transform, fwd, 0.0)
        n = math.hypot(fwd[0], fwd[2])
        if n < 0.3:  # looking mostly at the floor or ceiling
            continue
        ts = f.get("timestampSeconds")
        out.append(CameraFrame(frame_id, pos, (fwd[0] / n, fwd[2] / n),
                               float(ts) if isinstance(ts, (int, float)) else None))
    return out


def _angle(a: Vec2, b: Vec2) -> float:
    dot = max(-1.0, min(1.0, a[0] * b[0] + a[1] * b[1]))
    return math.degrees(math.acos(dot))


def _unit2(v, name: str) -> Vec2:
    if isinstance(v, dict):
        v = (v.get("x"), v.get("z"))
    try:
        x, z = float(v[0]), float(v[1])
    except (TypeError, ValueError, IndexError):
        raise FrameSelectError("{} must be {{x,z}}".format(name)) from None
    n = math.hypot(x, z)
    if not math.isfinite(n) or n < 1e-6:
        raise FrameSelectError("{} must be a non-zero direction".format(name))
    return (x / n, z / n)


def _point(v, name: str) -> Vec3:
    if isinstance(v, dict):
        v = (v.get("x"), v.get("y"), v.get("z"))
    try:
        p = tuple(float(c) for c in v)
    except (TypeError, ValueError):
        raise FrameSelectError("{} must be {{x,y,z}}".format(name)) from None
    if len(p) != 3 or not all(math.isfinite(c) for c in p):
        raise FrameSelectError("{} must be 3 finite numbers".format(name))
    return p  # type: ignore[return-value]


def score_frame(frame: CameraFrame, position: Vec3, incoming: Vec2, outgoing: Optional[Vec2],
                role: str, stairs: bool = False) -> Optional[float]:
    """Lower is better; None means the frame does not fit this role."""
    lo, hi, ideal, uses_out = ROLES[role]
    direction = outgoing if uses_out else incoming
    if direction is None:
        return None
    rx, rz = frame.position[0] - position[0], frame.position[2] - position[2]
    along = rx * direction[0] + rz * direction[1]
    lateral = abs(rx * direction[1] - rz * direction[0])
    facing = _angle(frame.forward, direction)
    dy = abs(frame.position[1] - EYE_HEIGHT_M - position[1])
    max_dy = MAX_STAIRS_DIFF_M if (uses_out and stairs) else MAX_FLOOR_DIFF_M
    if not (lo <= along <= hi) or lateral > MAX_LATERAL_M or facing > MAX_FACING_DEG or dy > max_dy:
        return None
    return abs(along - ideal) / (hi - lo) + lateral / MAX_LATERAL_M + facing / MAX_FACING_DEG


def select_frames(turn: dict, frames: Sequence[dict],
                  capture_to_space: Optional[Sequence[float]] = None) -> Dict[str, object]:
    """Pick one frame per role for a turn.

    ``turn`` is a turn from ``path_turns(...).to_dict()`` (needs ``position``,
    ``incomingHeading``, ``outgoingHeading``, optional ``maneuver``).
    Returns ``{"approach": id|None, "junction": ..., "exit": ..., "usable": bool,
    "scores": {...}}``. ``usable`` means at least two roles were found, which is
    the minimum a landmark request needs.
    """
    if not isinstance(turn, dict):
        raise FrameSelectError("turn must be an object")
    position = _point(turn.get("position"), "turn.position")
    incoming = _unit2(turn.get("incomingHeading"), "turn.incomingHeading")
    outgoing = turn.get("outgoingHeading")
    outgoing = _unit2(outgoing, "turn.outgoingHeading") if outgoing is not None else None
    stairs = str(turn.get("maneuver", "")).startswith("stairs")
    candidates = parse_frames(frames, capture_to_space)

    chosen: Dict[str, Optional[str]] = {}
    scores: Dict[str, Optional[float]] = {}
    used = set()
    for role in ("junction", "approach", "exit"):  # junction first: it matters most
        best, best_score = None, None
        for f in candidates:
            if f.frame_id in used:
                continue
            s = score_frame(f, position, incoming, outgoing, role, stairs)
            if s is not None and (best_score is None or s < best_score):
                best, best_score = f, s
        chosen[role] = best.frame_id if best else None
        scores[role] = round(best_score, 3) if best_score is not None else None
        if best:
            used.add(best.frame_id)
    found = [r for r in ("approach", "junction", "exit") if chosen[r]]
    return {
        "approach": chosen["approach"],
        "junction": chosen["junction"],
        "exit": chosen["exit"],
        "usable": len(found) >= 2,
        "scores": scores,
        "consideredFrames": len(candidates),
    }
