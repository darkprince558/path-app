import { api } from '../../../../../../lib/api/http';
import { privateAsset, shareFrame } from '../../../../../../lib/api/shares';
import { captureStorage } from '../../../../../../lib/storage/captures';

export const runtime = 'nodejs';
type Context = { params: Promise<{ shareId: string; frameId: string }> };
export async function GET(request: Request, context: Context) {
  const { shareId, frameId } = await context.params;
  return api(request, async ({ db, user }) => privateAsset(await shareFrame(db, captureStorage(), user, shareId, frameId), 'image/jpeg'), true);
}
