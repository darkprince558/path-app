import { api } from '../../../../../lib/api/http';
import { shareSceneResponse } from '../../../../../lib/api/shares';
import { scanStorage } from '../../../../../lib/storage';

export const runtime = 'nodejs';
type Context = { params: Promise<{ shareId: string }> };
/** The map's model. Browsers may keep it and revalidate (ETag + 304) on later opens. */
export async function GET(request: Request, context: Context) {
  const { shareId } = await context.params;
  return api(request, async ({ db, user }) => shareSceneResponse(request, db, scanStorage(), user, shareId), true);
}
