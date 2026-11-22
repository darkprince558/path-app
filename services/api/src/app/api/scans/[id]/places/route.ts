import { api, body, signedIn } from '../../../../../lib/api/http';
import { createPlace, placeInput } from '../../../../../lib/api/places';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** The owner pins a named place on the scan. */
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => Response.json({
    place: await createPlace(db, signedIn(user), id, await body(request, placeInput)),
  }, { status: 201 }));
}
