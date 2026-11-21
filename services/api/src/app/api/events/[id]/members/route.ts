import { eq } from 'drizzle-orm';
import { eventMembers } from '../../../../../db/schema';
import { readEvent } from '../../../../../lib/api/events';
import { api, signedIn } from '../../../../../lib/api/http';
import { uuid } from '../../../../../lib/api/validation';
import { requireOwner } from '../../../../../lib/auth/authorization';

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const event = await readEvent(db, user, uuid.parse(id));
    requireOwner(signedIn(user), event.ownerId);
    const members = await db.select().from(eventMembers).where(eq(eventMembers.eventId, event.id));
    return Response.json({ members });
  });
}
