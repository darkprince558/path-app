# Scan API contract (local development)

Sam owns these Next.js routes in `services/api`. Files are stored outside `public/` under `SCAN_STORAGE_DIR` (default `services/api/.local-scans`), and every file GET checks the current database permissions. Local storage is **development-only**: container rebuilds or ephemeral disks can erase files. The `ScanStorage` interface has `put`, `get`, `delete`, and `exists` methods, plus optional presigned upload/download methods for a future Vultr S3-compatible adapter. No Vultr credentials are needed now.

Capture and frontend teams share the [GLB and navigation coordinate contract](scan-data-contract.md), including scale calibration, origin, transformation order and alignment metadata.

| Request | Result |
| --- | --- |
| `POST /api/spaces/:id/scans` | Owner uploads `multipart/form-data` with `file` (`.glb`), `name`, `transform` (JSON array of 16 numbers), optional `visibility` (`private` or `public`) and `metadata` (JSON object). Returns 201 `{scan}`. Limit: 32 MiB GLB. |
| `GET /api/spaces/:id/scans` | `{scans: [...]}` of accessible scans. The space itself must be readable. |
| `GET /api/scans/:id` | `{scan}` metadata for an authorized viewer. |
| `GET /api/scans/:id/file` | Authorized GLB bytes, `model/gltf-binary`, with `Cache-Control: private, no-store`. |
| `PATCH /api/scans/:id` | Owner changes `name`, `visibility`, `transform` or `metadata`; returns `{scan}`. |
| `DELETE /api/scans/:id` | Owner removes the row and local object; returns 204. |

`scan` includes `id`, `spaceId`, `ownerId`, `name`, `visibility`, `format` (`glb`), `byteSize`, `status` (`ready`), `transform`, `metadata`, timestamps and `downloadPath`. It omits the internal `objectKey`. The existing database `shareId` is present but this phase does not provide an unlisted link route. Public scans require a public space; private scans require ownership or an explicit `scan_viewers` grant **and** access to the parent space. Event membership alone does not reveal private scans. Pending seed scans are visible only to their owner and have `downloadPath: null`. Inaccessible IDs return 404. Writes require Auth0 and return 401 when signed out.

The shared space uses +Y up. Coordinates represent metres **only after calibration**; monocular camera reconstruction has unknown physical scale until measured. `transform` is a **column-major** 4×4 matrix mapping scan-local positions into the shared space frame, matching glTF/Three.js `Matrix4.elements`. For a point `(x,y,z,1)`, the translated coordinates are `(m[0]x+m[4]y+m[8]z+m[12], m[1]x+m[5]y+m[9]z+m[13], m[2]x+m[6]y+m[10]z+m[14])`. Identity is `[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]`. Uploads and patches require finite values, affine bottom row `[0,0,0,1]`, and a nonsingular linear part. Use a positive uniform scale, rotation and translation for manual alignment. PR #19 already bakes its reconstruction-to-view transform into the GLB positions; do not apply that transform again. A scan transform does not create walkable navigation edges.

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

The GLB validator checks the GLB v2 header, declared length, JSON chunk and chunk boundaries. Buffers and textures must be embedded (BIN/bufferView or data URI); external and relative asset URLs are rejected so protected scans cannot depend on unauthenticated sidecar files. It does not validate mesh semantics or renderability; confirm the chosen export in the viewer.

The normal automated database test uses a tiny synthetic GLB and a disposable PostgreSQL database. It verifies multiple scans, owner-only writes, public and private downloads, immediate visibility changes, and that event membership alone cannot reveal private scan bytes. A scan viewer grant also requires access to the parent space; revoking that space access blocks the next download. Graph tests reject foreign-space nodes and reverse traversal of one-way edges. Production supports public/private visibility; unlisted sharing remains in the fixture mock and is not a production API option.

Run `TEST_DATABASE_URL=<disposable-migrated-url> npm test` with the Auth0 configuration from the API README. To exercise a real capture without adding private geometry to Git, also set `REAL_SCAN_GLB_FILE=/absolute/path/to/room.glb`. That optional test parses multipart form data, stores the model through the production scan service, checks its public download SHA-256 and metadata, and changes it to private to verify denial. It is skipped when no real file is supplied and does not verify rendering, physical scale, or an Auth0 browser login. Do not run these tests against a shared Tiger Data database.
