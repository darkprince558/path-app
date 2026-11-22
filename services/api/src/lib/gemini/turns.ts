// Turn-by-turn directions from a walking path's corner points.
//
// Copied from services/gemini/clients/typescript/turns.ts (keep them identical).
// TypeScript twin of services/gemini/src/path_gemini/turns.py. Copy this file
// into the web viewer or the API; it has no dependencies. Both versions must
// pass services/gemini/fixtures/turn_cases.json.
//
// Input: the points a router returns (for example NavMesh route().points),
// in metres, right-handed, +Y up. Output: one entry per decision point plus
// the arrival. Plain geometry; Gemini is not involved.
//
//   under 20 degrees   straight (not announced)
//   20 to 45 degrees   slight_left / slight_right
//   45 to 150 degrees  left / right
//   over 150 degrees   u_turn
//   last point         arrive
//   steep climb/drop   stairs_up / stairs_down (side = left/right turn into them)

export type Point = { x: number; y: number; z: number };
export type Heading = { x: number; z: number };
export type Maneuver =
  | "left" | "right" | "straight" | "slight_left" | "slight_right"
  | "u_turn" | "arrive" | "stairs_up" | "stairs_down";

export type Turn = {
  index: number; // index into the original points list
  position: Point;
  maneuver: Maneuver;
  side: "left" | "right" | null; // stairs only
  angleDegrees: number; // signed, positive = left
  incomingHeading: Heading;
  outgoingHeading: Heading | null; // null at arrival
  distanceFromStart: number;
  instruction: string;
};

export const STRAIGHT_MAX_DEG = 20;
export const SLIGHT_MAX_DEG = 45;
export const TURN_MAX_DEG = 150;
export const SIMPLIFY_TOLERANCE_M = 0.3;
export const STAIRS_MIN_RISE_M = 0.5;
export const STAIRS_MIN_SLOPE_DEG = 15;
export const LANDING_MAX_M = 2.5;
const DUPLICATE_EPS_M = 1e-3;
const MAX_POINTS = 2048;

const INSTRUCTIONS: Record<string, string> = {
  left: "Turn left", right: "Turn right", slight_left: "Bear left", slight_right: "Bear right",
  u_turn: "Turn around", straight: "Continue straight", arrive: "Arrive at your destination",
};

export class PathError extends Error {}

type V3 = [number, number, number];
type V2 = [number, number];

const deg = (rad: number) => (rad * 180) / Math.PI;
const dist3 = (a: V3, b: V3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const horizontal = (a: V3, b: V3) => Math.hypot(b[0] - a[0], b[2] - a[2]);
const round = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f + 0; // + 0 turns -0 into 0
};

/** Angle from incoming to outgoing (x, z) directions; positive = left (+Y up). */
export function signedTurnDegrees(a: V2, b: V2): number {
  return deg(Math.atan2(a[1] * b[0] - a[0] * b[1], a[0] * b[0] + a[1] * b[1]));
}

export function classify(angle: number): Maneuver {
  const a = Math.abs(angle);
  if (a < STRAIGHT_MAX_DEG) return "straight";
  if (a < SLIGHT_MAX_DEG) return angle > 0 ? "slight_left" : "slight_right";
  if (a <= TURN_MAX_DEG) return angle > 0 ? "left" : "right";
  return "u_turn";
}

function coerce(points: unknown): V3[] {
  if (!Array.isArray(points) || points.length < 2) throw new PathError("a path needs at least two points");
  if (points.length > MAX_POINTS) throw new PathError(`a path may have at most ${MAX_POINTS} points`);
  return points.map((p, i) => {
    const v = Array.isArray(p) ? p : p && typeof p === "object" ? [(p as Point).x, (p as Point).y, (p as Point).z] : [];
    if (v.length !== 3 || !v.every(n => typeof n === "number" && Number.isFinite(n))) {
      throw new PathError(`point ${i} must be {x,y,z} or [x,y,z] finite numbers`);
    }
    return v as V3;
  });
}

function perpDistance(p: V3, a: V3, b: V3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const denom = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2;
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1, (ab[0]! * ap[0]! + ab[1]! * ap[1]! + ab[2]! * ap[2]!) / denom));
  return Math.hypot(ap[0]! - t * ab[0]!, ap[1]! - t * ab[1]!, ap[2]! - t * ab[2]!);
}

function simplify(indices: number[], pts: V3[], tol: number): number[] {
  if (indices.length <= 2) return indices;
  const a = pts[indices[0]!]!, b = pts[indices[indices.length - 1]!]!;
  let best = 0, bestD = -1;
  for (let k = 1; k < indices.length - 1; k++) {
    const d = perpDistance(pts[indices[k]!]!, a, b);
    if (d > bestD) { best = k; bestD = d; }
  }
  if (bestD <= tol) return [indices[0]!, indices[indices.length - 1]!];
  const left = simplify(indices.slice(0, best + 1), pts, tol);
  const right = simplify(indices.slice(best), pts, tol);
  return left.slice(0, -1).concat(right);
}

function unit(a: V3, b: V3): V2 | null {
  const dx = b[0] - a[0], dz = b[2] - a[2], n = Math.hypot(dx, dz);
  return n < DUPLICATE_EPS_M ? null : [dx / n, dz / n];
}

function stairsDirection(a: V3, b: V3): "up" | "down" | null {
  const rise = b[1] - a[1], run = horizontal(a, b);
  if (Math.abs(rise) < STAIRS_MIN_RISE_M) return null;
  if (run > 0 && deg(Math.atan2(Math.abs(rise), run)) < STAIRS_MIN_SLOPE_DEG) return null;
  return rise > 0 ? "up" : "down";
}

function instructionFor(m: Maneuver, side: "left" | "right" | null): string {
  if (m === "stairs_up" || m === "stairs_down") {
    const verb = `take the stairs ${m === "stairs_up" ? "up" : "down"}`;
    return side ? `Turn ${side} and ${verb}` : verb[0]!.toUpperCase() + verb.slice(1);
  }
  return INSTRUCTIONS[m]!;
}

/** Decision points along a path, ending with "arrive". */
export function pathTurns(points: Point[] | V3[], options: { includeStraight?: boolean; simplifyTolerance?: number } = {}): Turn[] {
  const pts = coerce(points);
  const tol = options.simplifyTolerance ?? SIMPLIFY_TOLERANCE_M;
  let keep = [0];
  for (let i = 1; i < pts.length; i++) if (dist3(pts[i]!, pts[keep[keep.length - 1]!]!) > DUPLICATE_EPS_M) keep.push(i);
  if (keep.length < 2) throw new PathError("the path has no length");
  keep = simplify(keep, pts, tol);

  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1]! + dist3(pts[i - 1]!, pts[i]!));

  const legs: (V2 | null)[] = [];
  for (let k = 0; k < keep.length - 1; k++) legs.push(unit(pts[keep[k]!]!, pts[keep[k + 1]!]!));
  for (let k = 0; k < legs.length; k++) {
    if (legs[k]) continue;
    let found: V2 | null = null;
    for (let j = k - 1; j >= 0 && !found; j--) found = legs[j] ?? null;
    for (let j = k + 1; j < legs.length && !found; j++) found = legs[j] ?? null;
    legs[k] = found;
  }
  if (legs.some(l => !l)) throw new PathError("the path never moves horizontally");
  const stairs = legs.map((_, k) => stairsDirection(pts[keep[k]!]!, pts[keep[k + 1]!]!));
  for (let k = 1; k < stairs.length - 1; k++) {
    if (stairs[k] === null && stairs[k - 1] && stairs[k - 1] === stairs[k + 1] &&
        horizontal(pts[keep[k]!]!, pts[keep[k + 1]!]!) < LANDING_MAX_M) stairs[k] = stairs[k - 1]!;
  }

  const toPoint = (v: V3): Point => ({ x: v[0], y: v[1], z: v[2] });
  const toHeading = (v: V2): Heading => ({ x: round(v[0], 4), z: round(v[1], 4) });
  const turns: Turn[] = [];
  for (let k = 1; k < keep.length - 1; k++) {
    const incoming = legs[k - 1]!, outgoing = legs[k]!;
    const angle = signedTurnDegrees(incoming, outgoing);
    let maneuver = classify(angle);
    let side: "left" | "right" | null = null;
    if (stairs[k] && !stairs[k - 1]) {
      if (maneuver !== "straight") side = angle > 0 ? "left" : "right";
      maneuver = stairs[k] === "up" ? "stairs_up" : "stairs_down";
    } else if (stairs[k] && stairs[k - 1]) {
      continue; // landing in the middle of a staircase
    }
    if (maneuver === "straight" && !options.includeStraight) continue;
    const idx = keep[k]!;
    turns.push({
      index: idx, position: toPoint(pts[idx]!), maneuver, side, angleDegrees: round(angle, 1),
      incomingHeading: toHeading(incoming), outgoingHeading: toHeading(outgoing),
      distanceFromStart: round(along[idx]!, 2), instruction: instructionFor(maneuver, side),
    });
  }
  const last = keep[keep.length - 1]!;
  turns.push({
    index: last, position: toPoint(pts[last]!), maneuver: "arrive", side: null, angleDegrees: 0,
    incomingHeading: toHeading(legs[legs.length - 1]!), outgoingHeading: null,
    distanceFromStart: round(along[last]!, 2), instruction: instructionFor("arrive", null),
  });
  return turns;
}

export type ApprovedCue = {
  maneuver: Maneuver;
  side?: "left" | "right" | null;
  position: Point;
  incomingHeading: Heading;
  approvedText: string;
  [extra: string]: unknown;
};

/**
 * Find the organizer-approved cue for a turn: same maneuver, within 2 m, and
 * approached from the same direction (within 45 degrees). A cue recorded while
 * walking one way never matches the opposite direction.
 */
export function matchCue(turn: Turn, cues: ApprovedCue[], maxDistance = 2, maxHeadingDeg = 45): ApprovedCue | null {
  let best: ApprovedCue | null = null, bestD = Infinity;
  const p: V3 = [turn.position.x, turn.position.y, turn.position.z];
  for (const cue of cues) {
    if (cue.maneuver !== turn.maneuver) continue;
    if (turn.side && cue.side != null && cue.side !== turn.side) continue;
    const c = cue.position, h = cue.incomingHeading;
    if (!c || !h || ![c.x, c.y, c.z, h.x, h.z].every(n => typeof n === "number" && Number.isFinite(n))) continue;
    const d = dist3(p, [c.x, c.y, c.z]);
    const hd = Math.abs(signedTurnDegrees([turn.incomingHeading.x, turn.incomingHeading.z], [h.x, h.z]));
    if (d <= maxDistance && hd <= maxHeadingDeg && d < bestD) { best = cue; bestD = d; }
  }
  return best;
}
