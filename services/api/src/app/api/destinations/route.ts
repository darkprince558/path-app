import { and, eq } from 'drizzle-orm';
import { destinations, navNodes, spaces } from '../../../db/schema';
import { canReadSpace, readSpace } from '../../../lib/api/access';
import { api, badRequest, body, signedIn } from '../../../lib/api/http';
import { destinationInput } from '../../../lib/api/validation';
import { requireOwner } from '../../../lib/auth/authorization';

export function GET(request: Request) {
  return api(request, async ({ db, user }) => {
    const url = new URL(request.url);
    const spaceId = url.searchParams.get('spaceId');
    if (spaceId) {
      const space = await readSpace(db, user, spaceId);
      return Response.json({ destinations: await db.select().from(destinations).where(eq(destinations.spaceId, space.id)) });
    }
    const all = await db.select().from(destinations).innerJoin(spaces, eq(spaces.id, destinations.spaceId));
    const visible = [];
    for (const row of all) if (await canReadSpace(db, user, row.spaces)) visible.push(row.destinations);
    return Response.json({ destinations: visible });
  }, true);
}

export function POST(request: Request) {
  return api(request, async ({ db, user }) => {
    const input = await body(request, destinationInput);
    const space = await readSpace(db, user, input.spaceId);
    requireOwner(signedIn(user), space.ownerId);
    const [node] = await db.select({ id: navNodes.id }).from(navNodes)
      .where(and(eq(navNodes.id, input.nodeId), eq(navNodes.spaceId, space.id))).limit(1);
    if (!node) throw badRequest('Destination node must belong to this space');
    const [destination] = await db.insert(destinations).values(input).returning();
    return Response.json({ destination }, { status: 201 });
  });
}
