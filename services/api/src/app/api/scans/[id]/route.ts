import { api, body, signedIn } from '../../../../lib/api/http';
import { deleteScan, readScan, scanPatch, scanResponse, updateScan } from '../../../../lib/api/scans';
import { scanStorage } from '../../../../lib/storage';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => Response.json({ scan: scanResponse(await readScan(db, user, id)) }), true);
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => Response.json({
    scan: await updateScan(db, signedIn(user), id, await body(request, scanPatch)),
  }));
}

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    await deleteScan(db, scanStorage(), signedIn(user), id);
    return new Response(null, { status: 204 });
  });
}
