import { api, signedIn } from '../../../../../lib/api/http';
import { uploadCaptureFile } from '../../../../../lib/api/captures';
import { captureStorage } from '../../../../../lib/storage/captures';

export const runtime = 'nodejs';
type Context = { params: Promise<{ captureId: string }> };
export async function POST(request: Request, context: Context) {
  const { captureId } = await context.params;
  return api(request, async ({ db, user }) => Response.json(await uploadCaptureFile(
    db, captureStorage(), signedIn(user), captureId, request,
  )));
}
