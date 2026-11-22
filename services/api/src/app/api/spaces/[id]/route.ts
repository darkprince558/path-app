import { and, eq } from 'drizzle-orm';
import { eventSpaces, events, navEdges, navNodes, destinations, paths, scans, spaces } from '../../../../db/schema';
import { readSpace } from '../../../../lib/api/access';
import { api, body, conflict, notFound, signedIn } from '../../../../lib/api/http';
import { spaceInput, uuid } from '../../../../lib/api/validation';
import { requireOwner } from '../../../../lib/auth/authorization';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => Response.json({ space: await readSpace(db, user, uuid.parse(id)) }), true);
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const space = await readSpace(db, user, uuid.parse(id));
    requireOwner(signedIn(user), space.ownerId);
    const input = await body(request, spaceInput.partial());
    if (input.visibility === 'private' && space.visibility === 'public') {
      const [publicPath] = await db.select({ id: paths.id }).from(paths)
        .where(and(eq(paths.spaceId, space.id), eq(paths.visibility, 'public'))).limit(1);
      const [publicEvent] = await db.select({ id: events.id }).from(eventSpaces)
        .innerJoin(events, eq(events.id, eventSpaces.eventId))
        .where(and(eq(eventSpaces.spaceId, space.id), eq(events.visibility, 'public'))).limit(1);
      if (publicPath || publicEvent) throw conflict('Remove public paths and event references before making this space private');
    }
    const [updated] = await db.update(spaces).set({ ...input, updatedAt: new Date() }).where(eq(spaces.id, id)).returning();
    return Response.json({ space: updated });
  });
}

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const space = await readSpace(db, user, uuid.parse(id));
    requireOwner(signedIn(user), space.ownerId);
    const [path] = await db.select({ id: paths.id }).from(paths).where(eq(paths.spaceId, id)).limit(1);
    const [scan] = await db.select({ id: scans.id }).from(scans).where(eq(scans.spaceId, id)).limit(1);
    const [event] = await db.select({ id: eventSpaces.eventId }).from(eventSpaces).where(eq(eventSpaces.spaceId, id)).limit(1);
    if (path || scan || event) throw conflict('Remove paths, scans and event references before deleting this space');
    await db.transaction(async (tx) => {
      await tx.delete(destinations).where(eq(destinations.spaceId, id));
      await tx.delete(navEdges).where(eq(navEdges.spaceId, id));
      await tx.delete(navNodes).where(eq(navNodes.spaceId, id));
      await tx.delete(spaces).where(eq(spaces.id, id));
    });
    return new Response(null, { status: 204 });
  });
}
