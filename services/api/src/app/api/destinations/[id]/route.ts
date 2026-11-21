import { and, eq } from 'drizzle-orm';
import { destinations, eventDestinations, navNodes } from '../../../../db/schema';
import { readSpace } from '../../../../lib/api/access';
import { api, badRequest, body, notFound, signedIn } from '../../../../lib/api/http';
import { destinationInput, uuid } from '../../../../lib/api/validation';
import { requireOwner } from '../../../../lib/auth/authorization';

type Context = { params: Promise<{ id: string }> };
async function load(db: Parameters<typeof readSpace>[0], id: string) {
  const [destination] = await db.select().from(destinations).where(eq(destinations.id, uuid.parse(id))).limit(1);
  if (!destination) throw notFound();
  return destination;
}
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const destination = await load(db, id);
    await readSpace(db, user, destination.spaceId);
    return Response.json({ destination });
  }, true);
}
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const destination = await load(db, id);
    const space = await readSpace(db, user, destination.spaceId);
    requireOwner(signedIn(user), space.ownerId);
    const input = await body(request, destinationInput.omit({ spaceId: true }).partial());
    if (input.nodeId) {
      const [node] = await db.select({ id: navNodes.id }).from(navNodes)
        .where(and(eq(navNodes.id, input.nodeId), eq(navNodes.spaceId, space.id))).limit(1);
      if (!node) throw badRequest('Destination node must belong to this space');
    }
    const [updated] = await db.update(destinations).set(input).where(eq(destinations.id, id)).returning();
    return Response.json({ destination: updated });
  });
}
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const destination = await load(db, id);
    const space = await readSpace(db, user, destination.spaceId);
    requireOwner(signedIn(user), space.ownerId);
    await db.transaction(async tx => {
      await tx.delete(eventDestinations).where(eq(eventDestinations.destinationId, id));
      await tx.delete(destinations).where(eq(destinations.id, id));
    });
    return new Response(null, { status: 204 });
  });
}
