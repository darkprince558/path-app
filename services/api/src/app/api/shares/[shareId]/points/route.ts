import { api } from '../../../../../lib/api/http';
import { privateAsset, sharePoints } from '../../../../../lib/api/shares';
import { revisionStorage } from '../../../../../lib/storage/revisions';

export const runtime = 'nodejs';
type Context = { params: Promise<{ shareId: string }> };
export async function GET(request: Request, context: Context) {
  const { shareId } = await context.params;
  return api(request, async ({ db, user }) => privateAsset(await sharePoints(db, revisionStorage(), user, shareId), 'application/ply'), true);
}
