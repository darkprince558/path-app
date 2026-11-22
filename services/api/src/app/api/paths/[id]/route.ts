import { and, eq } from 'drizzle-orm';
import { eventPaths, events, paths, pathWaypoints } from '../../../../db/schema';
import { readPath } from '../../../../lib/api/access';
import { api, badRequest, body, conflict, signedIn } from '../../../../lib/api/http';
import { pathResponse, validateWaypoints } from '../../../../lib/api/paths';
import { pathInput, uuid } from '../../../../lib/api/validation';
import { requireOwner } from '../../../../lib/auth/authorization';

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const { path } = await readPath(db, user, uuid.parse(id));
    return Response.json({ path: await pathResponse(db, path) });
  }, true);
}
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const { path, space } = await readPath(db, user, uuid.parse(id));
    requireOwner(signedIn(user), path.ownerId);
    const { nodeIds, ...input } = await body(request, pathInput.omit({ spaceId: true }).partial());
    if (input.visibility === 'public' && space.visibility !== 'public') throw badRequest('A public path requires a public space');
    if (input.visibility === 'private' && path.visibility === 'public') {
      const [publicEvent] = await db.select({ id: events.id }).from(eventPaths)
        .innerJoin(events, eq(events.id, eventPaths.eventId))
        .where(and(eq(eventPaths.pathId, id), eq(events.visibility, 'public'))).limit(1);
      if (publicEvent) throw conflict('Remove event references before making this path private');
    }
    if (nodeIds) await validateWaypoints(db, space.id, nodeIds);
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(paths).set({ ...input, updatedAt: new Date() }).where(eq(paths.id, id)).returning();
      if (nodeIds) {
        await tx.delete(pathWaypoints).where(eq(pathWaypoints.pathId, id));
        await tx.insert(pathWaypoints).values(nodeIds.map((nodeId, sequence) => ({ pathId: id, spaceId: space.id, nodeId, sequence })));
      }
      return row;
    });
    return Response.json({ path: await pathResponse(db, updated) });
  });
}
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const { path } = await readPath(db, user, uuid.parse(id));
    requireOwner(signedIn(user), path.ownerId);
    await db.transaction(async tx => {
      await tx.delete(eventPaths).where(eq(eventPaths.pathId, id));
      await tx.delete(paths).where(eq(paths.id, id));
    });
    return new Response(null, { status: 204 });
  });
}
