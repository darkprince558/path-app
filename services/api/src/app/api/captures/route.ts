import { api, signedIn } from '../../../lib/api/http';
import { boundedCaptureJson, registerCapture } from '../../../lib/api/captures';
import { captureStorage } from '../../../lib/storage/captures';

export const runtime = 'nodejs';
export function POST(request: Request) {
  return api(request, async ({ db, user }) => {
    const result = await registerCapture(db, captureStorage(), signedIn(user), await boundedCaptureJson(request));
    return Response.json({ capture: result.capture }, { status: result.created ? 201 : 200 });
  });
}
