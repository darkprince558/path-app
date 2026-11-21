import { api, body, signedIn } from '../../../../../lib/api/http';
import { approveRevision, approvalInput } from '../../../../../lib/api/revision-approval';
import { scanStorage } from '../../../../../lib/storage';
import { revisionStorage } from '../../../../../lib/storage/revisions';

export const runtime = 'nodejs';
type Context = { params: Promise<{ revisionId: string }> };
export async function POST(request: Request, context: Context) {
  const { revisionId } = await context.params;
  return api(request, async ({ db, user }) => {
    const result = await approveRevision(db, scanStorage(), revisionStorage(), signedIn(user), revisionId, await body(request, approvalInput));
    return Response.json({ scan: result.scan, sharePath: result.sharePath }, { status: result.created ? 201 : 200 });
  });
}
