import { api } from '../../../../../lib/api/http';
import { listShareCues } from '../../../../../lib/api/cues';

export const runtime = 'nodejs';
type Context = { params: Promise<{ shareId: string }> };

export async function GET(request: Request, context: Context) {
  const { shareId } = await context.params;
  return api(request, async ({ db, user }) => Response.json({ cues: await listShareCues(db, user, shareId) }, {
    headers: { 'Cache-Control': 'private, no-store' },
  }), true);
}
