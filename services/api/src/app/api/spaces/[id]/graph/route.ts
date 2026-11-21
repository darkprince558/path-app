import { and, eq, inArray } from 'drizzle-orm';
import { destinations, navEdges, navNodes } from '../../../../../db/schema';
import { readSpace } from '../../../../../lib/api/access';
import { api } from '../../../../../lib/api/http';
import { uuid } from '../../../../../lib/api/validation';

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const space = await readSpace(db, user, uuid.parse(id));
    const [nodes, edges, places] = await Promise.all([
      db.select().from(navNodes).where(eq(navNodes.spaceId, space.id)),
      db.select().from(navEdges).where(eq(navEdges.spaceId, space.id)),
      db.select().from(destinations).where(eq(destinations.spaceId, space.id)),
    ]);
    return Response.json({ spaceId: space.id, nodes, edges, destinations: places });
  }, true);
}
