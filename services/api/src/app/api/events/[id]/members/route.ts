import { listEventMembers } from '../../../../../lib/api/event-maps';
import { api, signedIn } from '../../../../../lib/api/http';

type Context = { params: Promise<{ id: string }> };
/** Organizer only: `{members: [{eventId, userId, role, displayName}]}`. */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => Response.json(await listEventMembers(db, signedIn(user), id)));
}
