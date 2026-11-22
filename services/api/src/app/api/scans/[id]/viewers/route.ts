import { api, body, signedIn } from '../../../../../lib/api/http';
import { addViewer, listViewers, viewerInput } from '../../../../../lib/api/scan-viewers';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** Owner only: people added to this map. */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => Response.json(await listViewers(db, signedIn(user), id)));
}

/** Owner only: `{email}` adds the account(s) with that verified email. */
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) =>
    Response.json(await addViewer(db, signedIn(user), id, await body(request, viewerInput))));
}
