import { desc, eq } from 'drizzle-orm';
import { spaces } from '../../../db/schema';
import { listSpaces } from '../../../lib/api/access';
import { api, body, signedIn } from '../../../lib/api/http';
import { spaceInput } from '../../../lib/api/validation';

export function GET(request: Request) {
  return api(request, async ({ db, user }) => Response.json({ spaces: await listSpaces(db, user) }), true);
}

export function POST(request: Request) {
  return api(request, async ({ db, user }) => {
    const input = await body(request, spaceInput);
    const [space] = await db.insert(spaces).values({ ...input, ownerId: signedIn(user).id }).returning();
    return Response.json({ space }, { status: 201 });
  });
}
