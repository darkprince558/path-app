import { api, signedIn } from '../../../../lib/api/http';
import { readJob } from '../../../../lib/api/jobs';

export const runtime = 'nodejs';
type Context = { params: Promise<{ jobId: string }> };
export async function GET(request: Request, context: Context) {
  const { jobId } = await context.params;
  return api(request, async ({ db, user }) => Response.json({ job: await readJob(db, signedIn(user), jobId) }, {
    headers: { 'Cache-Control': 'private, no-store' },
  }));
}
