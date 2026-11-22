import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { eventMembers, events } from '../../../../../db/schema';
import { invitePreview } from '../../../../../lib/api/event-maps';
import { api, body, notFound, signedIn } from '../../../../../lib/api/http';
import { uuid } from '../../../../../lib/api/validation';

type Context = { params: Promise<{ id: string }> };

/** Invite link preview: `?code=` must match. Works signed out so the page can ask people to sign in. */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const code = new URL(request.url).searchParams.get('code');
  return api(request, async ({ db, user }) => Response.json(await invitePreview(db, user, id, code)), true);
}
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const member = signedIn(user);
    const { inviteCode } = await body(request, z.object({ inviteCode: z.string().min(1) }).strict());
    const [event] = await db.select().from(events).where(eq(events.id, uuid.parse(id))).limit(1);
    if (!event || event.visibility !== 'private' || event.inviteCode !== inviteCode) throw notFound();
    if (event.ownerId !== member.id) await db.insert(eventMembers)
      .values({ eventId: event.id, userId: member.id }).onConflictDoNothing();
    return Response.json({ eventId: event.id, role: event.ownerId === member.id ? 'organizer' : 'member' });
  });
}

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const member = signedIn(user);
    await db.delete(eventMembers).where(and(eq(eventMembers.eventId, uuid.parse(id)), eq(eventMembers.userId, member.id)));
    return new Response(null, { status: 204 });
  });
}
