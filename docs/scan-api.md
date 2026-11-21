# Scan API contract (local development)

Sam owns these Next.js routes in `services/api`. Files are stored outside `public/` under `SCAN_STORAGE_DIR` (default `services/api/.local-scans`), and every file GET checks the current database permissions. Local storage is **development-only**: container rebuilds or ephemeral disks can erase files. The `ScanStorage` interface has `put`, `get`, `delete`, and `exists` methods, plus optional presigned upload/download methods for a future Vultr S3-compatible adapter. No Vultr credentials are needed now.

| Request | Result |
| --- | --- |
| `POST /api/spaces/:id/scans` | Owner uploads `multipart/form-data` with `file` (`.glb`), `name`, `transform` (JSON array of 16 numbers), optional `visibility` (`private` or `public`) and `metadata` (JSON object). Returns 201 `{scan}`. Limit: 32 MiB GLB. |
| `GET /api/spaces/:id/scans` | `{scans: [...]}` of accessible scans. The space itself must be readable. |
| `GET /api/scans/:id` | `{scan}` metadata for an authorized viewer. |
| `GET /api/scans/:id/file` | Authorized GLB bytes, `model/gltf-binary`, with `Cache-Control: private, no-store`. |
| `PATCH /api/scans/:id` | Owner changes `name`, `visibility`, `transform` or `metadata`; returns `{scan}`. |
| `DELETE /api/scans/:id` | Owner removes the row and local object; returns 204. |

`scan` includes `id`, `spaceId`, `ownerId`, `name`, `visibility`, `format` (`glb`), `byteSize`, `status` (`ready`), `transform`, `metadata`, timestamps and `downloadPath`. It omits the internal `objectKey`. The existing database `shareId` is present but this phase does not provide an unlisted link route. Public scans require a public space; private scans require ownership or an explicit `scan_viewers` grant **and** access to the parent space. Event membership alone does not reveal private scans. Pending seed scans are visible only to their owner and have `downloadPath: null`. Inaccessible IDs return 404. Writes require Auth0 and return 401 when signed out.

All coordinates are metres, +Y is vertical. `transform` is a **column-major** 4×4 matrix mapping scan-local positions into the shared space frame, matching glTF/Three.js `Matrix4.elements`. For a point `(x,y,z,1)`, the translated coordinates are `(m[0]x+m[4]y+m[8]z+m[12], m[1]x+m[5]y+m[9]z+m[13], m[2]x+m[6]y+m[10]z+m[14])`. Identity is `[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]`. This convention is provisional until Krishna and Anish confirm the capture export. A scan transform does not create walkable navigation edges.

## Browser walkthrough for Arielle

Run `npm run db:migrate` and `npm run dev` in `services/api`, then sign in at `http://localhost:3000`. In the browser console on that origin, create a space and choose the tiny [sample triangle GLB](../fixtures/venue/sample-triangle.glb) (432 bytes) with the picker. This verifies transport and placement only; substitute a real capture to check the viewer experience.

```js
const create = await fetch('/api/spaces', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Demo hall', visibility: 'public' }),
});
const { space } = await create.json();
const picker = document.createElement('input');
picker.type = 'file'; picker.accept = '.glb,model/gltf-binary'; picker.click();
// After choosing a file, run the remaining lines:
const form = new FormData();
form.set('file', picker.files[0]);
form.set('name', 'North hall');
form.set('visibility', 'public');
form.set('transform', JSON.stringify([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]));
const uploaded = await fetch(`/api/spaces/${space.id}/scans`, { method: 'POST', body: form });
const { scan } = await uploaded.json();
console.log(uploaded.status, scan);
console.log(await fetch(`/api/spaces/${space.id}/scans`).then(r => r.json()));
const glb = await fetch(scan.downloadPath).then(r => r.arrayBuffer());
console.log(glb.byteLength, scan.byteSize);
```

For rendering, fetch the space, list scans, then fetch each `downloadPath`. Feed its bytes to `GLTFLoader.parse` or create an object URL, and apply `scan.transform` to the model root as a column-major matrix. Multiple scans returned for one space share the same coordinate frame. Open `downloadPath` in a signed-out private window to test a public scan. Repeat with `visibility: 'private'`; the private window should receive 404 for metadata and file. An unauthenticated upload returns 401. Deleting the scan returns 204, and its file URL then returns 404.

The GLB validator checks the GLB v2 header, declared length, JSON chunk and chunk boundaries. It does not validate mesh semantics or renderability; confirm the chosen export in the viewer. The automated database test uses a tiny synthetic GLB and a disposable PostgreSQL database. Run `TEST_DATABASE_URL=<disposable-migrated-url> npm test`. Do not run it against a shared Tiger Data database.
