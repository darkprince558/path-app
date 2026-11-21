import { api, signedIn } from '../../../../../lib/api/http';
import { boundedFormData, createScan, listScans, parseUpload } from '../../../../../lib/api/scans';
import { scanStorage } from '../../../../../lib/storage';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => Response.json({ scans: await listScans(db, user, id) }), true);
}

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const owner = signedIn(user);
    const { file, input } = parseUpload(await boundedFormData(request));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const scan = await createScan(db, scanStorage(), owner, id, input, bytes, file.name);
    return Response.json({ scan }, { status: 201 });
  });
}
