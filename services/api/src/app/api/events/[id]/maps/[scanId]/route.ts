import { removeEventMap } from '../../../../../../lib/api/event-maps';
import { api, signedIn } from '../../../../../../lib/api/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; scanId: string }> };

/** Organizer only: detaches a map. Returns the event detail. */
export async function DELETE(request: Request, context: Context) {
  const { id, scanId } = await context.params;
  return api(request, async ({ db, user }) => Response.json(await removeEventMap(db, signedIn(user), id, scanId)));
}
