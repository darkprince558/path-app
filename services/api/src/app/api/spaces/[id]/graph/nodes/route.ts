import { eq } from 'drizzle-orm';
import { navNodes } from '../../../../../../db/schema';
import { readSpace } from '../../../../../../lib/api/access';
import { api, body, signedIn } from '../../../../../../lib/api/http';
import { node, uuid } from '../../../../../../lib/api/validation';
import { requireOwner } from '../../../../../../lib/auth/authorization';

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const space = await readSpace(db, user, uuid.parse(id));
    requireOwner(signedIn(user), space.ownerId);
    const input = await body(request, node);
    const [created] = await db.insert(navNodes).values({ ...input, spaceId: space.id }).returning();
    return Response.json({ node: created }, { status: 201 });
  });
}
