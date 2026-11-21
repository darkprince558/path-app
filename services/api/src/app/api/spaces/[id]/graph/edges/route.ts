import { and, eq, inArray } from 'drizzle-orm';
import { navEdges, navNodes } from '../../../../../../db/schema';
import { readSpace } from '../../../../../../lib/api/access';
import { api, body, badRequest, signedIn } from '../../../../../../lib/api/http';
import { edge, uuid } from '../../../../../../lib/api/validation';
import { requireOwner } from '../../../../../../lib/auth/authorization';

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const space = await readSpace(db, user, uuid.parse(id));
    requireOwner(signedIn(user), space.ownerId);
    const input = await body(request, edge);
    const nodes = await db.select({ id: navNodes.id }).from(navNodes)
      .where(and(eq(navNodes.spaceId, space.id), inArray(navNodes.id, [input.fromNodeId, input.toNodeId])));
    if (nodes.length !== 2) throw badRequest('Both edge nodes must belong to this space');
    const [created] = await db.insert(navEdges).values({ ...input, spaceId: space.id }).returning();
    return Response.json({ edge: created }, { status: 201 });
  });
}
