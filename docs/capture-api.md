# LiDAR capture ingestion API

Human owner: Sam. Producer: Anish. Frame consumer: Krishna. This version ingests the
agreed bundle using existing Tiger Data and Auth0 configuration. It does not process
geometry inside requests, publish navigation or invoke Gemini. Finalization now
queues [asynchronous processing](capture-processing.md), which creates draft revisions.
The owner must apply migration `0002_lidar_capture_foundation.sql` separately; the
API never applies migrations automatically. Existing scan routes are unchanged.

## Requests and access

All endpoints require the existing Auth0 session or valid API bearer token.
Registration requires space ownership; uploads/finalization require both capture
and parent-space ownership. Event members, scan viewers and public/unlisted guests
do not gain capture access. A nonowner capture ID returns 404. Errors use the
existing `{error:{code,message,issues?}}` envelope.

| Endpoint | Body | Success |
| --- | --- | --- |
| `POST /api/captures` | `application/json`: `{spaceId,manifest}` | 201 `{capture}`; identical registration retries return 200. |
| `POST /api/captures/:captureId/uploads?path=source.glb` | `application/octet-stream`: one declared file's raw bytes. Repeat for all files. | 200 `{captureId,path,byteSize,sha256}`. |
| `POST /api/captures/:captureId/finalize` | No body. | 200 `{capture,job}` with capture status `uploaded`; retries return the same capture and logical job. |

`capture` contains `id`, `spaceId`, `deviceCaptureId`, `status`, `manifestSha256`,
`trackingWarnings`, `createdAt` and `uploadedAt`. It omits internal object keys.
Use the server-generated `id` in API paths; the manifest's `captureId` is the
device UUID stored as `deviceCaptureId`. `(owner,deviceCaptureId)` identifies
registration retries. A different manifest or space under the same ID returns 409.
Registration is bounded to 2 MiB of UTF-8 JSON.

## Manifest version 1

Use [the complete synthetic manifest](../fixtures/lidar-capture/manifest.json).
Zod rejects unknown fields and enforces:

| Field | Contract |
| --- | --- |
| `version`, `captureId` | Version `1`, stable device UUID. |
| `device` | `{model,osVersion}`, nonempty strings. |
| `coordinateSystem` | `{units:"metres",upAxis:"Y",handedness:"right",matrixLayout:"column-major",poseConvention:"camera-to-capture"}`. |
| `entrancePose` | 16 finite numbers, nonsingular affine column-major matrix in the capture frame. |
| `capturedAt` | Optional ISO timestamp with timezone. |
| `trackingWarnings` | Up to 100 nonempty warning strings; defaults to `[]`. |
| `files` | Unique `{path,byteSize,sha256}` entries for every file except the manifest. Positive integer sizes and lowercase 64-character SHA-256. |

Required entries: `source.glb`, `points.ply`, `frames.json`, `preview.jpg`, and at
least one `frames/<id>.jpg`. Limits are 32 MiB per file, 256 MiB total, 2 MiB for
`frames.json`, and 1,000 frame images. Revisit these conservative development limits
with measured real exports before larger uploads.

Registration persists the validated manifest as `manifest.json`; do not list it in
`files` or upload it to `/uploads`. Its returned SHA-256 hashes normalized UTF-8 JSON:
object keys recursively sorted, no whitespace, array ordering preserved. This is
not the hash of an arbitrarily formatted input file and avoids a self-checksum cycle.

Only the four fixed filenames and `frames/<id>.jpg` are allowed. IDs contain 1–128
ASCII letters, digits, underscores or hyphens, starting with a letter/digit.
Traversal, absolute paths, backslashes, percent escapes in logical names, control
characters, extra separators and unknown files are rejected. URL-encode the `path`
query value once; manifest paths themselves are literal relative names.

## frames.json version 1

The index is `{version:1,captureId,frames:[...]}`. Example frame:

```json
{
  "id":"junction-02",
  "imagePath":"frames/junction-02.jpg",
  "cameraPose":[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
  "timestampSeconds":0.5,
  "width":8,"height":8,
  "intrinsics":{"fx":8,"fy":8,"cx":4,"cy":4}
}
```

The capture ID must match the manifest. IDs are unique; imagePath must equal
`frames/<id>.jpg`. Every manifest frame image has exactly one reference and every
reference has an inventory entry. Camera poses follow the declared convention and
the same matrix validation as entrance poses. In the column-major bottom row, indices
3, 7 and 11 must be zero. Index 15 accepts values from 0.999999 through 1.000001
inclusive to handle iPhone float rounding. Registration and processing preserve the
submitted values for checksum verification and retries. Timestamps are finite/nonnegative;
dimensions are positive integers. Optional intrinsics contain finite fx/fy/cx/cy
with positive focal lengths. Unknown fields are rejected. The API validates JSON
and references on upload and finalization, then inserts stable `capture_frames` rows.

This is the backend convention; Anish still needs to adapt/confirm native exporter
JSON, entrance semantics, camera axis/image orientation and baked GLB transforms.
Ingestion checks integrity and declarations, not binary mesh/image parseability,
LiDAR accuracy, physical alignment or walkability. Existing relative-unit scans are
not reinterpreted by this contract.

## Private storage and retries

`CAPTURE_STORAGE_DIR` defaults to `.local-captures` in the API working directory.
Keep it outside `public/` in a service-owned private directory. There is no static
or capture-download endpoint. Local storage is development-only; API instances need
the same disk until a durable S3-compatible adapter is added.

`CaptureStorage` supplies streamed `putVerified`, digest inspection and bounded JSON
reads. Implementations must stage privately, verify exact size/SHA-256 and atomically
promote immutable bytes. Local storage uses 0700 directories, 0600 files, temporary
writes and atomic hard-link promotion. It rejects symlinks within the trusted root.

The server computes hashes from actual bytes, even without Content-Length. If given,
Content-Length must match the inventory. Wrong hashes/sizes, undeclared files or bad
JSON return 400 and remove temporary writes. Finalization rehashes every file and the
stored manifest; missing/corrupt files return 409. No partial frame rows or uploaded
state are committed on failure. Identical file retries work until finalization;
different bytes never replace an accepted file. Post-finalization uploads return 409.

A capture-row lock serializes uploads/finalization across API processes; frame
insertion and state change are one transaction. Filesystem writes cannot join that
transaction, so a crash can leave private orphans. Retention/cleanup and repair of
externally corrupted objects remain future work. Finalization enqueues one persistent
job in the same transaction; follow its returned statusPath to `GET /api/jobs/:jobId`.

## Reproduce the fixture

Run the API with existing Auth0 settings and an already migrated development
database. Sign in as a space owner. In a same-origin browser console, select the
`fixtures/lidar-capture` directory, including its `frames/` subdirectory:

```js
const picker = document.createElement('input');
picker.type = 'file'; picker.webkitdirectory = true; picker.click();
// After selecting the folder:
const files = new Map([...picker.files].map(file => [
  file.webkitRelativePath.split('/').slice(1).join('/'), file
]));
const manifest = JSON.parse(await files.get('manifest.json').text());
const send = async (url, init) => {
  const response = await fetch(url, init);
  const result = await response.json();
  if (!response.ok) throw result;
  return result;
};
const spaceId = 'REPLACE_WITH_AN_OWNED_SPACE_UUID';
const {capture} = await send('/api/captures', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body:JSON.stringify({spaceId,manifest})
});
for (const file of manifest.files) {
  await send(`/api/captures/${capture.id}/uploads?path=${encodeURIComponent(file.path)}`, {
    method:'POST', headers:{'Content-Type':'application/octet-stream'}, body:files.get(file.path)
  });
}
console.log(await send(`/api/captures/${capture.id}/finalize`, {method:'POST'}));
```

Checks: API typecheck, db:check, tests with a disposable migrated TEST_DATABASE_URL,
production build, and root `make check`. Route tests run normal Auth0 signature,
issuer/audience verification and user sync with signed synthetic JWTs and a synthetic
JWKS response, local PostgreSQL and private files. They also cover retry/concurrency,
corruption, owner isolation, bounds and frame references. They do not verify physical
iPhone capture or a live Auth0 browser login.
