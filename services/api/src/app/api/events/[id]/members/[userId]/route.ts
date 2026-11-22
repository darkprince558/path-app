import { and, eq } from 'drizzle-orm';
import { eventMembers } from '../../../../../../db/schema';
import { readEvent } from '../../../../../../lib/api/events';
import { api, signedIn } from '../../../../../../lib/api/http';
import { uuid } from '../../../../../../lib/api/validation';
import { requireOwner } from '../../../../../../lib/auth/authorization';

type Context = { params: Promise<{ id: string; userId: string }> };
export async function DELETE(request: Request, context: Context) {
  const { id, userId } = await context.params;
  return api(request, async ({ db, user }) => {
    const event = await readEvent(db, user, uuid.parse(id));
    requireOwner(signedIn(user), event.ownerId);
    await db.delete(eventMembers).where(and(eq(eventMembers.eventId, event.id), eq(eventMembers.userId, uuid.parse(userId))));
    return new Response(null, { status: 204 });
  });
}
