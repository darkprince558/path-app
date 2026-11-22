import { BufferGeometry, Mesh, Raycaster, Vector3, type Intersection, type Object3D } from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, type MeshBVH } from "three-mesh-bvh";

/*
 * Walking inside a scan ("drop in", like Street View). Pure geometry helpers, so they can be
 * tested without a browser. Metres, +Y up, as everywhere in the viewer.
 *
 * Raycasting a phone scan (millions of triangles) is linear per ray without an index, far too
 * slow for following the floor every frame. three-mesh-bvh builds a bounding-volume tree per
 * mesh; installing its raycast on Mesh.prototype here, before any scan is prepared, means
 * lib/scan-surfaces.ts's wall-cut filter wraps the fast version. Meshes without a tree keep
 * three.js's normal raycast, so nothing else changes.
 */
declare module "three" {
  interface BufferGeometry { boundsTree?: MeshBVH; computeBoundsTree: typeof computeBoundsTree; disposeBoundsTree: typeof disposeBoundsTree }
}
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

/** Eye height of a standing adult. */
export const EYE_HEIGHT = 1.6;
/** Walking and running speeds in m/s (Shift runs; big buildings need it). */
export const WALK_SPEED = 2, RUN_SPEED = 6;
/** Stop this far from a wall. */
export const WALL_GAP = 0.35;
/** Highest step you can walk up, and the furthest drop the floor-follower accepts per move. */
export const MAX_STEP_UP = 0.45, MAX_STEP_DOWN = 1.2;
/**
 * Faces with |normal.y| at least this count as floor (and below it as wall). Phone scans
 * are bumpy: on the hole-filled Hack Western DEMO, walls are almost all under 0.2 and
 * floors/ceilings over 0.95, but plenty of floor triangles tilt to 0.4-0.6.
 */
const FLOOR_NORMAL_Y = 0.35;

/**
 * Builds a BVH for every mesh that has none (the index is left untouched: indirect mode),
 * so clicks and walking stay fast on multi-million-triangle scans. Returns the time taken.
 */
export function accelerate(roots: Object3D[]): number {
  const started = performance.now();
  for (const root of roots) root.traverse((object) => {
    if (object instanceof Mesh && !object.geometry.boundsTree) object.geometry.computeBoundsTree({ indirect: true });
  });
  return performance.now() - started;
}

export function disposeAcceleration(roots: Object3D[]) {
  for (const root of roots) root.traverse((object) => {
    if (object instanceof Mesh && object.geometry.boundsTree) object.geometry.disposeBoundsTree();
  });
}

const DOWN = new Vector3(0, -1, 0);

function worldNormalY(hit: Intersection): number {
  if (!hit.face) return 0;
  return hit.face.normal.clone().transformDirection(hit.object.matrixWorld).y;
}

/**
 * The floor under `point`: the highest upward-facing surface between `above` metres over it
 * and `below` metres under it. Null over a hole or outside the scan.
 */
export function floorBelow(raycaster: Raycaster, roots: Object3D[], point: Vector3, above = MAX_STEP_UP, below = MAX_STEP_DOWN): Vector3 | null {
  raycaster.set(new Vector3(point.x, point.y + above, point.z), DOWN);
  raycaster.near = 0;
  raycaster.far = above + below;
  // Scans are double-sided: a floor seen from above may be a face whose normal points down.
  const hit = raycaster.intersectObjects(roots, true).find((candidate) => Math.abs(worldNormalY(candidate)) >= FLOOR_NORMAL_Y);
  return hit ? hit.point.clone() : null;
}

/**
 * Where someone dropped at `hit` stands: on the floor under a floor hit, or under a wall or
 * object hit (searching down to 3 m). Null when there is no floor below.
 */
export function standingPoint(raycaster: Raycaster, roots: Object3D[], hit: Intersection): Vector3 | null {
  if (worldNormalY(hit) >= FLOOR_NORMAL_Y || -worldNormalY(hit) >= FLOOR_NORMAL_Y) {
    // A floor (or the underside of a double-sided floor): stand on it.
    return floorBelow(raycaster, roots, hit.point, 0.05, 0.3) ?? hit.point.clone();
  }
  return floorBelow(raycaster, roots, hit.point, 0.05, 3);
}

/**
 * One step of walking: from the eye position `eye`, move by `delta` (horizontal), stopping
 * WALL_GAP before a wall, then settle the eye EYE_HEIGHT above the floor. Over a gap in the
 * scan (no floor found) the height is kept, so small holes don't trap you.
 */
export function step(raycaster: Raycaster, roots: Object3D[], eye: Vector3, delta: Vector3): Vector3 {
  const move = new Vector3(delta.x, 0, delta.z);
  const length = move.length();
  const next = eye.clone();
  if (length > 1e-6) {
    const direction = move.clone().divideScalar(length);
    // Check at knee and chest height so low furniture and walls both stop you.
    let allowed = length;
    for (const lift of [EYE_HEIGHT - 1.1, EYE_HEIGHT - 0.4]) {
      raycaster.set(new Vector3(eye.x, eye.y - lift, eye.z), direction);
      raycaster.near = 0;
      raycaster.far = length + WALL_GAP;
      const wall = raycaster.intersectObjects(roots, true).find((hit) => Math.abs(worldNormalY(hit)) < FLOOR_NORMAL_Y);
      if (wall) allowed = Math.min(allowed, Math.max(0, wall.distance - WALL_GAP));
    }
    next.addScaledVector(direction, allowed);
  }
  const floor = floorBelow(raycaster, roots, new Vector3(next.x, next.y - EYE_HEIGHT, next.z));
  if (floor) next.y = floor.y + EYE_HEIGHT;
  return next;
}

/** Unit view direction for a heading (yaw, radians, 0 = -Z) and pitch (radians, up positive). */
export function lookDirection(yaw: number, pitch: number): Vector3 {
  return new Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

/** Heading (yaw) that looks along `direction` on the ground plane. */
export function headingOf(direction: Vector3): number {
  return Math.atan2(-direction.x, -direction.z);
}
