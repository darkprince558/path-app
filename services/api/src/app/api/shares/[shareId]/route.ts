import { api } from '../../../../lib/api/http';
import { shareMetadata } from '../../../../lib/api/shares';

type Context = { params: Promise<{ shareId: string }> };
export async function GET(request: Request, context: Context) {
  const { shareId } = await context.params;
  return api(request, async ({ db, user }) => Response.json(await shareMetadata(db, user, shareId), {
    headers: { 'Cache-Control': 'private, no-store' },
  }), true);
}
