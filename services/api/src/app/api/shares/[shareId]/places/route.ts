import { api } from '../../../../../lib/api/http';
import { listSharePlaces } from '../../../../../lib/api/places';

export const runtime = 'nodejs';
type Context = { params: Promise<{ shareId: string }> };

/** Named places on a shared map. Same access rule as the share itself. */
export async function GET(request: Request, context: Context) {
  const { shareId } = await context.params;
  return api(request, async ({ db, user }) => Response.json({ places: await listSharePlaces(db, user, shareId) }, {
    headers: { 'Cache-Control': 'private, no-store' },
  }), true);
}
