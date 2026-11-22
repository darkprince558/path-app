import type { Point } from "./navmesh";

/** Relative turns along the generated corridor, in the model's +Y-up frame. */
export function routeDirections(points: Point[]): string[] {
  const steps: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (length < 0.05) continue;
    let action = i === 1 ? "Start" : "Continue";
    if (i > 1) {
      const prev = points[i - 2]!;
      const dx = a.x - prev.x, dz = a.z - prev.z, nx = b.x - a.x, nz = b.z - a.z;
      const angle = Math.atan2(dx * nz - dz * nx, dx * nx + dz * nz) * 180 / Math.PI;
      if (Math.abs(angle) > 150) action = "Turn around";
      else if (Math.abs(angle) > 20) action = angle > 0 ? "Turn right" : "Turn left";
    }
    steps.push(`${action} and go ${length.toFixed(1)} m.`);
  }
  return [...steps, "Arrive at your destination."];
}
