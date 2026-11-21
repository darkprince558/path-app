import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { events } from '../../../../db/schema';
import { eventLinks, eventResponse, readEvent, replaceEventLinks, validateEventLinks } from '../../../../lib/api/events';
import { api, body, signedIn } from '../../../../lib/api/http';
import { eventInput, uuid } from '../../../../lib/api/validation';
import { requireOwner } from '../../../../lib/auth/authorization';

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => Response.json(await eventResponse(db, user, await readEvent(db, user, uuid.parse(id)))), true);
}
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const event = await readEvent(db, user, uuid.parse(id));
    const owner = signedIn(user);
    requireOwner(owner, event.ownerId);
    const input = await body(request, eventInput.partial());
    const oldLinks = await eventLinks(db, id);
    const links = { spaceIds: input.spaceIds ?? oldLinks.spaceIds, pathIds: input.pathIds ?? oldLinks.pathIds,
      destinationIds: input.destinationIds ?? oldLinks.destinationIds };
    await validateEventLinks(db, owner.id, input.visibility ?? event.visibility, links);
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(events).set({ name: input.name, description: input.description,
        visibility: input.visibility, inviteCode: input.visibility === 'public' ? null :
          input.visibility === 'private' ? (event.inviteCode ?? randomBytes(18).toString('base64url')) : undefined,
        updatedAt: new Date() }).where(eq(events.id, id)).returning();
      await replaceEventLinks(tx, id, links);
      return row;
    });
    return Response.json(await eventResponse(db, owner, updated));
  });
}
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const event = await readEvent(db, user, uuid.parse(id));
    requireOwner(signedIn(user), event.ownerId);
    await db.delete(events).where(eq(events.id, id));
    return new Response(null, { status: 204 });
  });
}
