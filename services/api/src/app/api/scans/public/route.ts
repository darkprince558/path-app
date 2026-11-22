import { api } from '../../../../lib/api/http';
import { listPublicScans } from '../../../../lib/api/scan-lists';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return api(request, async ({ db }) => Response.json({ scans: await listPublicScans(db) }), true);
}
