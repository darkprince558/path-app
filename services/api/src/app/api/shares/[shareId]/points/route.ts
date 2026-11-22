import { api } from '../../../../../lib/api/http';
import { sharePointsResponse } from '../../../../../lib/api/shares';
import { revisionStorage } from '../../../../../lib/storage/revisions';

export const runtime = 'nodejs';
type Context = { params: Promise<{ shareId: string }> };
/** The approved point cloud. Browsers may keep it and revalidate (ETag + 304). */
export async function GET(request: Request, context: Context) {
  const { shareId } = await context.params;
  return api(request, async ({ db, user }) => sharePointsResponse(request, db, revisionStorage(), user, shareId), true);
}
