import { Detour, getNavMeshPositionsAndIndices, init, NavMeshQuery, statusDetail } from "recast-navigation";
import { generateSoloNavMesh } from "recast-navigation/generators";
import { Mesh, Vector3, type Object3D } from "three";

export interface Point { x: number; y: number; z: number }
export interface Triangles { positions: number[]; indices: number[] }
export interface Agent { radius: number; height: number; slope: number; step: number }
export const DEFAULT_AGENT: Agent = { radius: 0.3, height: 1.8, slope: 40, step: 0.2 };
export const MAX_NAV_VERTICES = 2_000_000, MAX_NAV_TRIANGLES = 2_000_000;
const CS = 0.1, CH = 0.05;
// The SDK checks completed initialization, not an in-flight initialization.
// React StrictMode and concurrent callers must share one WASM module instance.
let initialization: Promise<void> | undefined;
function initialize() {
  return initialization ??= init().catch(error => { initialization = undefined; throw error; });
}
const finite = (p: Point) => [p.x, p.y, p.z].every(Number.isFinite);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Bake glTF hierarchy and scan-to-space matrixWorld exactly once. Metres, +Y up. */
export function trianglesFromObject(root: Object3D): Triangles {
  root.updateWorldMatrix(true, true);
  const positions: number[] = [], indices: number[] = [];
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    if ("isSkinnedMesh" in object || "isInstancedMesh" in object || object.geometry.morphAttributes.position?.length) throw new Error("Bake animated or instanced geometry before navigation.");
    const geometry = object.geometry, attribute = geometry.getAttribute("position");
    if (!attribute) throw new Error("Mesh has no triangle positions.");
    const offset = positions.length / 3;
    if (offset + attribute.count > MAX_NAV_VERTICES) throw new Error("Geometry exceeds the demo vertex budget.");
    const count = geometry.index?.count ?? attribute.count;
    if (indices.length + count > MAX_NAV_TRIANGLES * 3) throw new Error("Geometry exceeds the navigation triangle budget.");
    for (let i = 0; i < attribute.count; i++) {
      const p = new Vector3().fromBufferAttribute(attribute, i).applyMatrix4(object.matrixWorld);
      positions.push(p.x, p.y, p.z);
    }
    if (count % 3) throw new Error("Geometry must contain complete triangles.");
    const reflected = object.matrixWorld.determinant() < 0;
    const a = new Vector3(), b = new Vector3(), c = new Vector3();
    for (let i = 0; i < count; i += 3) {
      const index = (j: number) => offset + (geometry.index?.getX(j) ?? j);
      const ia = index(i), ib = index(i + (reflected ? 2 : 1)), ic = index(i + (reflected ? 1 : 2));
      a.fromArray(positions, ia * 3); b.fromArray(positions, ib * 3); c.fromArray(positions, ic * 3);
      // Depth fusion can emit zero-area faces. They occupy no surface and must not
      // disable navigation over the rest of the scan. Keep all nondegenerate walls.
      if (b.sub(a).cross(c.sub(a)).lengthSq() < 1e-16) continue;
      indices.push(ia, ib, ic);
    }
  });
  return { positions, indices };
}

function validate(input: Triangles, agent: Agent) {
  if (!Number.isFinite(agent.radius) || agent.radius < 0.1 || agent.radius > 1.5 ||
      !Number.isFinite(agent.height) || agent.height < 0.5 || agent.height > 3 ||
      !Number.isFinite(agent.slope) || agent.slope < 0 || agent.slope > 60 ||
      !Number.isFinite(agent.step) || agent.step < 0 || agent.step > 0.6 || agent.step >= agent.height) {
    throw new Error("Invalid agent dimensions or clearance settings.");
  }
  const { positions: p, indices: ix } = input;
  if (!p.length || p.length % 3 || p.length > MAX_NAV_VERTICES * 3 || !ix.length || ix.length % 3 || ix.length > MAX_NAV_TRIANGLES * 3 ||
      !p.every(Number.isFinite) || ix.some(i => !Number.isInteger(i) || i < 0 || i >= p.length / 3)) {
    throw new Error("Invalid or oversized triangle geometry.");
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) { const a = i % 3; min[a] = Math.min(min[a]!, p[i]!); max[a] = Math.max(max[a]!, p[i]!); }
  const x = Math.ceil((max[0]! - min[0]!) / CS), z = Math.ceil((max[2]! - min[2]!) / CS);
  const y = Math.max(1, Math.ceil((max[1]! - min[1]!) / CH));
  if (!x || !z || x * z > 2_000_000 || x * y * z > 30_000_000 || y > 65_000) throw new Error("Geometry exceeds the demo voxel budget or has empty bounds.");
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let i = 0; i < ix.length; i += 3) {
    a.fromArray(p, ix[i]! * 3); b.fromArray(p, ix[i + 1]! * 3); c.fromArray(p, ix[i + 2]! * 3);
    if (b.sub(a).cross(c.sub(a)).lengthSq() < 1e-16) throw new Error("Geometry contains degenerate triangles.");
  }
}

export type NavRoute = { ok: true; points: Point[]; distance: number } | { ok: false; message: string };

export async function buildNavMesh(input: Triangles, agent: Agent = DEFAULT_AGENT) {
  validate(input, agent);
  await initialize();
  const result = generateSoloNavMesh(input.positions, input.indices, {
    cs: CS, ch: CH, walkableRadius: Math.ceil(agent.radius / CS),
    walkableHeight: Math.ceil(agent.height / CH), walkableClimb: Math.floor(agent.step / CH),
    walkableSlopeAngle: agent.slope, minRegionArea: 0, mergeRegionArea: 0,
    maxSimplificationError: 0.5, detailSampleDist: 1, detailSampleMaxError: CH,
  });
  if (!result.success) throw new Error(`NavMesh generation failed: ${result.error}`);
  const mesh = result.navMesh;
  const [positions, indices] = getNavMeshPositionsAndIndices(mesh);
  if (!indices.length) { mesh.destroy(); throw new Error("No walkable surfaces for these settings."); }
  const query = new NavMeshQuery(mesh);
  let disposed = false;
  return {
    debug: { positions, indices },
    dispose() { if (!disposed) { disposed = true; query.destroy(); mesh.destroy(); } },
    route(start: Point, end: Point): NavRoute {
      if (disposed) return { ok: false, message: "Navigation has been disposed." };
      // Accept only points over a walkable polygon, with small vertical rasterization tolerance.
      // Never snap horizontally through a wall or silently move an endpoint to another floor.
      const snap = (p: Point) => finite(p) ? query.findClosestPoint(p, { halfExtents: { x: 0.05, y: 0.15, z: 0.05 } }) : null;
      const from = snap(start), to = snap(end);
      if (!from?.success || !from.polyRef || !from.isPointOverPoly || Math.abs(from.point.y - start.y) > 0.15 ||
          !to?.success || !to.polyRef || !to.isPointOverPoly || Math.abs(to.point.y - end.y) > 0.15) {
        return { ok: false, message: "Choose start and destination inside a walkable region." };
      }
      const corridor = query.findPath(from.polyRef, to.polyRef, from.point, to.point, { maxPathPolys: 2048 });
      try {
        if (!corridor.success || statusDetail(corridor.status, Detour.DT_PARTIAL_RESULT) ||
            statusDetail(corridor.status, Detour.DT_BUFFER_TOO_SMALL) || statusDetail(corridor.status, Detour.DT_OUT_OF_NODES) ||
            !corridor.polys.size || corridor.polys.get(corridor.polys.size - 1) !== to.polyRef) {
          return { ok: false, message: "No complete route connects these regions." };
        }
        const straight = query.findStraightPath(from.point, to.point, corridor.polys, { maxStraightPathPoints: 2048 });
        try {
          if (!straight.success || statusDetail(straight.status, Detour.DT_BUFFER_TOO_SMALL)) return { ok: false, message: "Route exceeds the query budget." };
          const points = Array.from({ length: straight.straightPathCount }, (_, i) => ({
            x: straight.straightPath.get(i * 3), y: straight.straightPath.get(i * 3 + 1), z: straight.straightPath.get(i * 3 + 2),
          }));
          if (!points.length || distance(points[points.length - 1]!, to.point) > 0.01) return { ok: false, message: "No complete route reaches the destination." };
          return { ok: true, points, distance: points.reduce((n, p, i) => n + (i ? distance(points[i - 1]!, p) : 0), 0) };
        } finally { straight.straightPath.destroy(); straight.straightPathFlags.destroy(); straight.straightPathRefs.destroy(); }
      } finally { corridor.polys.destroy(); }
    },
  };
}
export type NavigationMesh = Awaited<ReturnType<typeof buildNavMesh>>;
