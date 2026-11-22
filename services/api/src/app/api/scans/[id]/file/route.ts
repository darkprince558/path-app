import { api } from '../../../../../lib/api/http';
import { downloadScan } from '../../../../../lib/api/scans';
import { scanStorage } from '../../../../../lib/storage';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return api(request, async ({ db, user }) => {
    const { scan, bytes } = await downloadScan(db, scanStorage(), user, id);
    return new Response(Uint8Array.from(bytes), { headers: {
      'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="${scan.id}.glb"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  }, true);
}
