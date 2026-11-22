import { api, body, signedIn } from '../../../../lib/api/http';
import { deletePlace, placePatch, updatePlace } from '../../../../lib/api/places';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** The owner renames, re-categorises or moves a place. */
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => Response.json({
    place: await updatePlace(db, signedIn(user), id, await body(request, placePatch)),
  }));
}

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    await deletePlace(db, signedIn(user), id);
    return new Response(null, { status: 204 });
  });
}
