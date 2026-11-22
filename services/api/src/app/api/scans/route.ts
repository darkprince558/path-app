import { api, signedIn } from '../../../lib/api/http';
import { createBrowserScan, parseBrowserUpload } from '../../../lib/api/browser-upload';
import { scanStorage } from '../../../lib/storage';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return api(request, async ({ db, user }) => {
    const owner = signedIn(user);
    const { input, bytes } = await parseBrowserUpload(request);
    const scan = await createBrowserScan(db, scanStorage(), owner, input, bytes);
    return Response.json({ id: scan.id, shareId: scan.shareId, sharePath: `/s/${scan.shareId}`,
      name: scan.name, visibility: scan.visibility }, { status: 201 });
  });
}
