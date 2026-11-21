"""Turn-by-turn directions from a walking path's corner points.

Input is the ordered list of points a router returns, for example the NavMesh
``route().points``: metres, right-handed, +Y up (the shared space frame).
Output is one entry per decision point, plus the arrival. This is plain
geometry; Gemini is not involved. A person still confirms each turn.

How a corner is classified (angles measured on the floor plane, X/Z):

    under 20 degrees   straight (not announced)
    20 to 45 degrees   slight_left / slight_right
    45 to 150 degrees  left / right
    over 150 degrees   u_turn
    last point         arrive

When the stretch after a corner climbs or drops steeply (more than 0.5 m, and
steeper than 15 degrees), the turn becomes ``stairs_up`` / ``stairs_down``,
with ``side`` recording a left/right turn into the stairs.

``fixtures/turn_cases.json`` holds shared examples that the TypeScript twin
(``clients/typescript/turns.ts``) must reproduce exactly.
"""

import math
from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

from .models import Maneuver

Point = Tuple[float, float, float]

STRAIGHT_MAX_DEG = 20.0
SLIGHT_MAX_DEG = 45.0
TURN_MAX_DEG = 150.0
SIMPLIFY_TOLERANCE_M = 0.3
STAIRS_MIN_RISE_M = 0.5
STAIRS_MIN_SLOPE_DEG = 15.0
LANDING_MAX_M = 2.5  # a short flat stretch between two flights is a landing
DUPLICATE_EPS_M = 1e-3
MAX_POINTS = 2048

INSTRUCTIONS = {
    Maneuver.LEFT: "Turn left",
    Maneuver.RIGHT: "Turn right",
    Maneuver.SLIGHT_LEFT: "Bear left",
    Maneuver.SLIGHT_RIGHT: "Bear right",
    Maneuver.U_TURN: "Turn around",
    Maneuver.STRAIGHT: "Continue straight",
    Maneuver.ARRIVE: "Arrive at your destination",
}


class PathError(ValueError):
    """The path cannot be turned into directions."""


@dataclass(frozen=True)
class Turn:
    index: int  # index into the original points list
    position: Point
    maneuver: Maneuver
    side: Optional[str]  # "left" / "right" for stairs turns, else None
    angle_degrees: float  # signed, positive = left
    incoming: Tuple[float, float]  # unit (x, z) walking direction before the corner
    outgoing: Optional[Tuple[float, float]]  # unit (x, z) after; None at arrival
    distance_from_start: float
    instruction: str = field(default="")

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "position": {"x": self.position[0], "y": self.position[1], "z": self.position[2]},
            "maneuver": self.maneuver.value,
            "side": self.side,
            "angleDegrees": round(self.angle_degrees, 1),
            "incomingHeading": {"x": round(self.incoming[0], 4), "z": round(self.incoming[1], 4)},
            "outgoingHeading": None if self.outgoing is None else {
                "x": round(self.outgoing[0], 4), "z": round(self.outgoing[1], 4)},
            "distanceFromStart": round(self.distance_from_start, 2),
            "instruction": self.instruction,
        }


def signed_turn_degrees(incoming: Tuple[float, float], outgoing: Tuple[float, float]) -> float:
    """Angle from incoming to outgoing (x, z) directions; positive = left (+Y up)."""
    cross = incoming[1] * outgoing[0] - incoming[0] * outgoing[1]
    dot = incoming[0] * outgoing[0] + incoming[1] * outgoing[1]
    return math.degrees(math.atan2(cross, dot))


def classify(angle: float) -> Maneuver:
    a = abs(angle)
    if a < STRAIGHT_MAX_DEG:
        return Maneuver.STRAIGHT
    if a < SLIGHT_MAX_DEG:
        return Maneuver.SLIGHT_LEFT if angle > 0 else Maneuver.SLIGHT_RIGHT
    if a <= TURN_MAX_DEG:
        return Maneuver.LEFT if angle > 0 else Maneuver.RIGHT
    return Maneuver.U_TURN


def _coerce(points: Sequence) -> List[Point]:
    if not isinstance(points, (list, tuple)) or len(points) < 2:
        raise PathError("a path needs at least two points")
    if len(points) > MAX_POINTS:
        raise PathError("a path may have at most {} points".format(MAX_POINTS))
    out: List[Point] = []
    for i, p in enumerate(points):
        if isinstance(p, dict):
            p = (p.get("x"), p.get("y"), p.get("z"))
        try:
            x, y, z = (float(v) for v in p)
        except (TypeError, ValueError):
            raise PathError("point {} must be {{x,y,z}} or [x,y,z] numbers".format(i)) from None
        if not all(math.isfinite(v) for v in (x, y, z)):
            raise PathError("point {} is not finite".format(i))
        out.append((x, y, z))
    return out


def _horizontal(a: Point, b: Point) -> float:
    return math.hypot(b[0] - a[0], b[2] - a[2])


def _perp_distance(p: Point, a: Point, b: Point) -> float:
    """3D distance from p to segment ab (keeps stairs from being flattened away)."""
    ab = [b[i] - a[i] for i in range(3)]
    ap = [p[i] - a[i] for i in range(3)]
    denom = sum(v * v for v in ab)
    t = 0.0 if denom == 0 else max(0.0, min(1.0, sum(ab[i] * ap[i] for i in range(3)) / denom))
    return math.sqrt(sum((ap[i] - t * ab[i]) ** 2 for i in range(3)))


def _simplify(indices: List[int], pts: List[Point], tol: float) -> List[int]:
    """Ramer-Douglas-Peucker on point indices (first and last always kept)."""
    if len(indices) <= 2:
        return indices
    a, b = pts[indices[0]], pts[indices[-1]]
    best, best_d = 0, -1.0
    for k in range(1, len(indices) - 1):
        d = _perp_distance(pts[indices[k]], a, b)
        if d > best_d:
            best, best_d = k, d
    if best_d <= tol:
        return [indices[0], indices[-1]]
    left = _simplify(indices[: best + 1], pts, tol)
    right = _simplify(indices[best:], pts, tol)
    return left[:-1] + right


def _unit(a: Point, b: Point) -> Optional[Tuple[float, float]]:
    dx, dz = b[0] - a[0], b[2] - a[2]
    n = math.hypot(dx, dz)
    return None if n < DUPLICATE_EPS_M else (dx / n, dz / n)


def _stairs(a: Point, b: Point) -> Optional[str]:
    rise = b[1] - a[1]
    run = _horizontal(a, b)
    if abs(rise) < STAIRS_MIN_RISE_M:
        return None
    if run > 0 and math.degrees(math.atan2(abs(rise), run)) < STAIRS_MIN_SLOPE_DEG:
        return None
    return "up" if rise > 0 else "down"


def _instruction(maneuver: Maneuver, side: Optional[str]) -> str:
    if maneuver in (Maneuver.STAIRS_UP, Maneuver.STAIRS_DOWN):
        verb = "Take the stairs " + ("up" if maneuver is Maneuver.STAIRS_UP else "down")
        return "Turn {} and {}".format(side, verb[0].lower() + verb[1:]) if side else verb
    return INSTRUCTIONS[maneuver]


def path_turns(points: Sequence, *, include_straight: bool = False,
               simplify_tolerance: float = SIMPLIFY_TOLERANCE_M) -> List[Turn]:
    """Return the decision points along a path, ending with ``arrive``."""
    pts = _coerce(points)
    keep = [0]
    for i in range(1, len(pts)):
        if math.dist(pts[i], pts[keep[-1]]) > DUPLICATE_EPS_M:
            keep.append(i)
    if len(keep) < 2:
        raise PathError("the path has no length")
    keep = _simplify(keep, pts, simplify_tolerance)

    # Distance along the original path to each kept index.
    along = [0.0]
    for i in range(1, len(pts)):
        along.append(along[-1] + math.dist(pts[i - 1], pts[i]))

    # Walking direction of each leg; a purely vertical leg borrows its neighbour's.
    legs = [_unit(pts[keep[k]], pts[keep[k + 1]]) for k in range(len(keep) - 1)]
    for k in range(len(legs)):
        if legs[k] is None:
            legs[k] = next((legs[j] for j in range(k - 1, -1, -1) if legs[j]), None) or \
                next((legs[j] for j in range(k + 1, len(legs)) if legs[j]), None)
    if any(leg is None for leg in legs):
        raise PathError("the path never moves horizontally")
    stairs = [_stairs(pts[keep[k]], pts[keep[k + 1]]) for k in range(len(keep) - 1)]
    # Short flat legs between two flights going the same way are landings:
    # treat them as part of the stairs so nothing is announced mid-staircase.
    for k in range(1, len(stairs) - 1):
        if (stairs[k] is None and stairs[k - 1] and stairs[k - 1] == stairs[k + 1]
                and _horizontal(pts[keep[k]], pts[keep[k + 1]]) < LANDING_MAX_M):
            stairs[k] = stairs[k - 1]

    turns: List[Turn] = []
    for k in range(1, len(keep) - 1):
        incoming, outgoing = legs[k - 1], legs[k]
        angle = signed_turn_degrees(incoming, outgoing)
        maneuver = classify(angle)
        side = None
        if stairs[k] and not stairs[k - 1]:
            if maneuver is not Maneuver.STRAIGHT:
                side = "left" if angle > 0 else "right"
            maneuver = Maneuver.STAIRS_UP if stairs[k] == "up" else Maneuver.STAIRS_DOWN
        elif stairs[k] and stairs[k - 1]:
            continue  # landing in the middle of a staircase: keep following the stairs
        if maneuver is Maneuver.STRAIGHT and not include_straight:
            continue
        idx = keep[k]
        turns.append(Turn(idx, pts[idx], maneuver, side, angle, incoming, outgoing, along[idx],
                          _instruction(maneuver, side)))

    last = keep[-1]
    turns.append(Turn(last, pts[last], Maneuver.ARRIVE, None, 0.0, legs[-1], None, along[last],
                      _instruction(Maneuver.ARRIVE, None)))
    return turns


def heading_difference_degrees(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return abs(signed_turn_degrees(a, b))


def match_cue(turn: Turn, cues: Sequence[dict], *, max_distance: float = 2.0,
              max_heading_deg: float = 45.0) -> Optional[dict]:
    """Find an approved cue for this turn: same maneuver, nearby, same approach direction.

    Each cue is ``{"position": {x,y,z}, "incomingHeading": {x,z}, "maneuver": str, ...}``.
    A cue recorded walking one way never matches the opposite direction.
    """
    best, best_d = None, None
    for cue in cues:
        if cue.get("maneuver") != turn.maneuver.value:
            continue
        if turn.side and cue.get("side") not in (None, turn.side):
            continue
        p = cue.get("position") or {}
        h = cue.get("incomingHeading") or {}
        try:
            d = math.dist(turn.position, (float(p["x"]), float(p["y"]), float(p["z"])))
            hd = heading_difference_degrees(turn.incoming, (float(h["x"]), float(h["z"])))
        except (KeyError, TypeError, ValueError):
            continue
        if d <= max_distance and hd <= max_heading_deg and (best_d is None or d < best_d):
            best, best_d = cue, d
    return best
