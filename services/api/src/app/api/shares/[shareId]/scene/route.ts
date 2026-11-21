import { api } from '../../../../../lib/api/http';
import { privateAsset, shareScene } from '../../../../../lib/api/shares';
import { scanStorage } from '../../../../../lib/storage';

export const runtime = 'nodejs';
type Context = { params: Promise<{ shareId: string }> };
export async function GET(request: Request, context: Context) {
  const { shareId } = await context.params;
  return api(request, async ({ db, user }) => privateAsset(await shareScene(db, scanStorage(), user, shareId), 'model/gltf-binary'), true);
}
