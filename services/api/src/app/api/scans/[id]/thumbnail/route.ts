import { api } from '../../../../../lib/api/http';
import { readThumbnailBody, saveThumbnail } from '../../../../../lib/api/thumbnails';
import { scanStorage } from '../../../../../lib/storage';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** The owner saves the map-card picture (a small JPEG of the 3D view). */
export async function PUT(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    await saveThumbnail(db, scanStorage(), user, id, await readThumbnailBody(request));
    return new Response(null, { status: 204 });
  });
}
