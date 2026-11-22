import { api, signedIn } from '../../../../../lib/api/http';
import { listRevisionCues } from '../../../../../lib/api/cues';

export const runtime = 'nodejs';
type Context = { params: Promise<{ revisionId: string }> };

export async function GET(request: Request, context: Context) {
  const { revisionId } = await context.params;
  return api(request, async ({ db, user }) => Response.json({ cues: await listRevisionCues(db, signedIn(user), revisionId) }, {
    headers: { 'Cache-Control': 'private, no-store' },
  }));
}
