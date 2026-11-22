import { z } from 'zod';
import { api, body, signedIn } from '../../../../../lib/api/http';
import { restoreCaptureCalibration } from '../../../../../lib/api/scan-calibration';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const owner = signedIn(user);
    await body(request, z.object({}).strict());
    return Response.json({ scan: await restoreCaptureCalibration(db, owner, id) });
  });
}
