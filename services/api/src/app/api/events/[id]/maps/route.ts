import { addEventMap, eventMapInput } from '../../../../../lib/api/event-maps';
import { api, body, signedIn } from '../../../../../lib/api/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** Organizer only: `{scanId}` attaches one of their own maps. Returns the event detail. */
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) =>
    Response.json(await addEventMap(db, signedIn(user), id, await body(request, eventMapInput))));
}
