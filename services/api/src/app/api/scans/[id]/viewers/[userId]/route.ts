import { api, signedIn } from '../../../../../../lib/api/http';
import { removeViewer } from '../../../../../../lib/api/scan-viewers';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; userId: string }> };

/** Owner only: removes one person's access. */
export async function DELETE(request: Request, context: Context) {
  const { id, userId } = await context.params;
  return api(request, async ({ db, user }) => Response.json(await removeViewer(db, signedIn(user), id, userId)));
}
