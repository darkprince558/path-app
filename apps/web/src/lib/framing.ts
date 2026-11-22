import { Mesh, PerspectiveCamera, Vector3, type Object3D } from "three";

/*
 * Fitting a camera to what a scan actually covers. A whole-building walk is a long, thin
 * zigzag (the Hack Western DEMO is 129 x 281 m of corridors): framing its bounding sphere
 * leaves the building in a fifth of the screen. These helpers frame the bulk of the
 * scan's points instead, and are shared by the opening view, the map-card picture and the
 * browser tests (which must know exactly where the camera starts).
 */

/** Up to ~`max` world-space points spread over every mesh. */
export function samplePoints(objects: Object3D[], max = 20000): Vector3[] {
  const points: Vector3[] = [];
  let total = 0;
  for (const root of objects) root.traverse((object) => {
    if (object instanceof Mesh) total += object.geometry.getAttribute("position")?.count ?? 0;
  });
  const step = Math.max(1, Math.floor(total / max));
  for (const root of objects) {
    root.updateMatrixWorld(true);
    root.traverse((object) => {
      const positions = object instanceof Mesh ? object.geometry.getAttribute("position") : undefined;
      if (!positions) return;
      for (let i = 0; i < positions.count; i += step) points.push(new Vector3().fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld));
    });
  }
  return points;
}

/** The value below which `share` of the values fall. */
export function quantile(values: number[], share: number) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
}

/** The box holding the bulk of the points (1st to 99th percentile per axis; stray depth points ignored). */
export function bulkBox(points: Vector3[]) {
  const axis = (pick: (p: Vector3) => number) => { const v = points.map(pick); return [quantile(v, 0.01), quantile(v, 0.99)] as const; };
  const [x0, x1] = axis((p) => p.x), [y0, y1] = axis((p) => p.y), [z0, z1] = axis((p) => p.z);
  const center = new Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const size = new Vector3(x1 - x0, y1 - y0, z1 - z0);
  return { center, size, radius: Math.max(size.length() / 2, 0.001) };
}

/**
 * Distance along `direction` (unit, from the centre toward the camera) at which `fill` of
 * the points (98th percentile) fit inside the view.
 */
export function fitDistance(points: Vector3[], center: Vector3, direction: Vector3, fov: number, aspect: number, fill = 0.92): number {
  const { radius } = bulkBox(points);
  const camera = new PerspectiveCamera(fov, aspect, radius / 1000, radius * 100);
  let distance = radius * 3;
  for (let pass = 0; pass < 5; pass++) {
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.lookAt(center); camera.updateMatrixWorld();
    const reach = quantile(points.map((point) => {
      const ndc = point.clone().project(camera);
      return Math.max(Math.abs(ndc.x), Math.abs(ndc.y));
    }), 0.98);
    distance *= Math.max(reach, 0.05) / fill;
  }
  return Math.max(distance, radius * 0.05);
}

/**
 * The opening "dollhouse" view: about 50° down, from the side that lays a long scan's
 * length across the screen (across a wide screen, up a tall one).
 */
export function overviewDirection(size: Vector3, aspect: number): Vector3 {
  const longAlongZ = size.z > size.x * 1.2, longAlongX = size.x > size.z * 1.2;
  const wide = aspect >= 1;
  // From +Z the scan's X runs across the screen; from +X its Z does.
  const fromX = (longAlongZ && wide) || (longAlongX && !wide);
  return (fromX ? new Vector3(0.64, 0.77, 0) : new Vector3(0, 0.77, 0.64)).normalize();
}

/** Where the opening view puts the camera and what it looks at. */
export function overviewPose(points: Vector3[], fov: number, aspect: number) {
  const box = bulkBox(points);
  const direction = overviewDirection(box.size, aspect);
  const distance = fitDistance(points, box.center, direction, fov, aspect);
  return { target: box.center, position: box.center.clone().addScaledVector(direction, distance), radius: box.radius, distance };
}

