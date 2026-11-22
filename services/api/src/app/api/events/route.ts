import { randomBytes } from 'node:crypto';
import { events } from '../../../db/schema';
import { canReadEvent, eventResponse, replaceEventLinks, validateEventLinks } from '../../../lib/api/events';
import { eventDetail } from '../../../lib/api/event-maps';
import { api, body, signedIn } from '../../../lib/api/http';
import { eventInput } from '../../../lib/api/validation';

export function GET(request: Request) {
  return api(request, async ({ db, user }) => {
    const all = await db.select().from(events);
    const visible = [];
    for (const event of all) if (await canReadEvent(db, user, event)) visible.push((await eventResponse(db, user, event)).event);
    return Response.json({ events: visible });
  }, true);
}
export function POST(request: Request) {
  return api(request, async ({ db, user }) => {
    const owner = signedIn(user);
    const { spaceIds, pathIds, destinationIds, ...input } = await body(request, eventInput);
    const links = { spaceIds, pathIds, destinationIds };
    await validateEventLinks(db, owner.id, input.visibility ?? 'private', links);
    const event = await db.transaction(async (tx) => {
      const [created] = await tx.insert(events).values({ ...input, ownerId: owner.id,
        inviteCode: input.visibility === 'public' ? null : randomBytes(18).toString('base64url') }).returning();
      await replaceEventLinks(tx, created.id, links);
      return created;
    });
    return Response.json(await eventDetail(db, owner, event), { status: 201 });
  });
}
