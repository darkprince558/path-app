import { asc, eq } from 'drizzle-orm';
import type { connectDatabase } from '../../db/client';
import { navEdges, navNodes, paths, pathWaypoints, spaces } from '../../db/schema';
import { badRequest } from './http';
import { isConnectedPath } from './path-validation';

type Db = ReturnType<typeof connectDatabase>['db'];
export async function validateWaypoints(db: Db, spaceId: string, nodeIds: string[]) {
  const [nodes, edges] = await Promise.all([
    db.select({ id: navNodes.id }).from(navNodes).where(eq(navNodes.spaceId, spaceId)),
    db.select({ fromNodeId: navEdges.fromNodeId, toNodeId: navEdges.toNodeId, bidirectional: navEdges.bidirectional })
      .from(navEdges).where(eq(navEdges.spaceId, spaceId)),
  ]);
  if (!isConnectedPath(nodeIds, new Set(nodes.map(n => n.id)), edges)) {
    throw badRequest('Every consecutive waypoint must follow an edge in its allowed direction within this space');
  }
}
export async function pathResponse(db: Db, path: typeof paths.$inferSelect) {
  const waypoints = await db.select({ nodeId: pathWaypoints.nodeId, sequence: pathWaypoints.sequence,
    x: navNodes.x, y: navNodes.y, z: navNodes.z, floor: navNodes.floor })
    .from(pathWaypoints).innerJoin(navNodes, eq(navNodes.id, pathWaypoints.nodeId))
    .where(eq(pathWaypoints.pathId, path.id)).orderBy(asc(pathWaypoints.sequence));
  return { ...path, waypoints };
}
