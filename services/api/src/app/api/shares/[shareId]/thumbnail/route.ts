import { api } from '../../../../../lib/api/http';
import { cachedAsset, contentEtag } from '../../../../../lib/api/http-cache';
import { shareThumbnail } from '../../../../../lib/api/thumbnails';
import { scanStorage } from '../../../../../lib/storage';

export const runtime = 'nodejs';
type Context = { params: Promise<{ shareId: string }> };

/**
 * The map-card picture, for anyone who can open the map. 404 until the owner has opened it once.
 * Pictures are replaced in place, so the ETag hashes the content; repeat visits get a 304.
 */
export async function GET(request: Request, context: Context) {
  const { shareId } = await context.params;
  return api(request, async ({ db, user }) => {
    const bytes = await shareThumbnail(db, scanStorage(), user, shareId);
    return cachedAsset(request, contentEtag(bytes), 'image/jpeg', async () => bytes);
  }, true);
}
