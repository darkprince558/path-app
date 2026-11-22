import { api, signedIn } from '../../../../lib/api/http';
import { listSharedScans } from '../../../../lib/api/scan-lists';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return api(request, async ({ db, user }) => Response.json({ scans: await listSharedScans(db, signedIn(user)) }));
}
