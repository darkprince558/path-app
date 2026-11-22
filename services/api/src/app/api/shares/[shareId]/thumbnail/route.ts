import { api } from '../../../../../lib/api/http';
import { privateAsset } from '../../../../../lib/api/shares';
import { shareThumbnail } from '../../../../../lib/api/thumbnails';
import { scanStorage } from '../../../../../lib/storage';

export const runtime = 'nodejs';
type Context = { params: Promise<{ shareId: string }> };

/** The map-card picture, for anyone who can open the map. 404 until the owner has opened it once. */
export async function GET(request: Request, context: Context) {
  const { shareId } = await context.params;
  return api(request, async ({ db, user }) => privateAsset(await shareThumbnail(db, scanStorage(), user, shareId), 'image/jpeg'), true);
}
