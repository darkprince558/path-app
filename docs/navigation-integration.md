# !404 GLB navigation integration

Human owner: Sam. Capture handoff: Anish and Krishna. Frontend review: Arielle.
Task: [#23](https://github.com/darkprince558/path-app/issues/23).

## Included changes

The integration branch combines the existing backend and PR #15 viewer as dependencies.
It adds a small space/event experience in Arielle's existing React, Vite, React Router
and Three.js architecture. It does not merge the later map-management/settings branches
or the reconstruction tools. PR #19 remains the producer of the real textured GLB.

| Route | Behavior |
| --- | --- |
| `/spaces` | Lists accessible spaces; signed-in users can create a public/private space and choose relative or calibrated metric coordinates. |
| `/spaces/:id` | Downloads each accessible ready GLB from its protected file route, preserves its textures/materials, applies `scan.transform`, and renders it alongside the space graph. |
| `/events/:id` | Shows accessible event spaces and saved paths; links into the same space viewer. |
| `/s/:shareId` | Preserves the legacy mock's PLY viewer and adds GLB support; this is separate from the core API space links. |

The owner can upload scans, set their sharing, align them, pick floor locations,
connect nodes and label destinations. Guests choose start/destination nodes or an
existing saved path. A* respects directed edges and uses an admissible cost-scaled
heuristic. Saved paths are rechecked against the current graph and use the graph's
current coordinates. No automatic route is inferred from the room surface.

## Run against the existing backend

1. In `services/api`, use the existing environment configuration, database migration
   commands and Auth0 setup in its README. Keep local scan storage outside `public/`.
2. For Vite development, use `APP_BASE_URL=http://localhost:5173` in the API and add
   `http://localhost:5173/auth/callback` to Auth0's Allowed Callback URLs and the same
   origin to Allowed Logout URLs. This is a manual Auth0 application configuration
   step; it has not been changed automatically. Preserve the existing API-origin
   callbacks if teammates still use them.
3. Run `npm run dev` in `services/api`. In `apps/web`, run
   `pnpm install --frozen-lockfile` and `pnpm dev`. If Next binds to IPv6 localhost,
   use `API_TARGET=http://localhost:3000 pnpm dev`, or start Next with
   `node_modules/.bin/next dev --hostname 127.0.0.1 --port 3000`.
4. Open `http://localhost:5173/spaces`, sign in, and create a space. Keep the same
   browser hostname throughout so the Auth0 session remains on one origin.

For deployment, serve the Vite build and Next `/api` and `/auth` under one HTTPS
origin. SPA routes `/spaces/*`, `/events/*`, and `/s/*` must fall back to `index.html`.
Cloud storage and GPU work remain deferred.

## Real scan handoff

1. Anish supplies PR #19's private `mesh/hallway.glb` (embedded textures, <=32 MiB).
   Keep the original capture and reconstruction report private and out of Git.
2. Create a space using **Relative** units if no measured baseline is available.
   The exporter has already applied its `world_to_view`; begin with identity.
3. Open **Owner tools → Upload and align scans**, name the GLB and upload it. Choose
   Public for both the space and intended scan when preparing a signed-out demo.
4. Select the uploaded scan. Rotate its observed floor to Y-up and position the
   chosen origin. Use the alignment controls to generate the matrix, then save.
   For metric spaces, double-click two known model points, save points A/B, enter
   the measured separation and calculate scale. Verify orientation and origin, then
   tick the confirmation and save alignment. This records a human check, not an
   accuracy estimate. A measured baseline does not remove mesh distortion.
5. Add locations by double-clicking floor surfaces or entering space coordinates.
   Name the start, turns and destination. Add explicit connections after physically
   verifying the route. The UI records source scan IDs for picked nodes and locks
   that scan's alignment afterward. Legacy/manual nodes without a scan association
   conservatively lock all existing alignment. Finalize those scans first.
6. Choose Start and Destination and press **Show route**. Save a named path. Select
   that saved path to verify the same connected route appears. Optional graph
   visibility is independent of the highlighted route.
7. Copy `/spaces/:id`, or create a public event link from Owner tools. Open the link
   in a fresh browser session on a second device. Public spaces show only public
   scans. Event membership alone never grants private scan access.

The [data contract](scan-data-contract.md) defines units, matrix order, calibration,
scan-to-space placement and graph coordinates. UI alignment controls replace the
absolute scan transform; they do not multiply an extra transform into the vertices.
The backend remains authoritative for ownership and visibility. Verification metadata
is a shared convention, not a replacement for server authorization.

## Repeatable software checks

```sh
# Repository fixture and all three legacy mock sharing modes
make check

cd apps/web
pnpm test
pnpm build

cd ../../services/api
npm run typecheck
TEST_DATABASE_URL=<disposable-migrated-postgres-url> npm test
npm run build
```

`REAL_SCAN_GLB_FILE=/private/path/hallway.glb TEST_DATABASE_URL=... npm test` enables
the optional multipart/service upload, storage and checksum test on real bytes. It
does not prove texture appearance, Auth0 login or walkability.

To prepare a **synthetic software test only**, run the script below against a disposable
localhost database whose name contains `test` or `stage1`. Use placeholder Auth0
configuration for this isolated test server, never a production database. The script
creates uniquely named rows and leaves them for browser verification; discard the
disposable database afterward. It generates a tiny four-color textured plane, two
aligned public scans, private scans, directed graph, saved path and event.

```sh
cd services/api
TEST_DATABASE_URL=<disposable-migrated-postgres-url> \
AUTH0_DOMAIN=example.auth0.com AUTH0_CLIENT_ID=test-client \
AUTH0_CLIENT_SECRET=test-only AUTH0_AUDIENCE=https://api.not404.test \
AUTH0_SECRET=0000000000000000000000000000000000000000000000000000000000000000 \
node_modules/.bin/tsx scripts/prepare-navigation-test.ts
```

The script prints a report path with resource IDs and `storageRoot`. Start Next with
that database as `DATABASE_URL`, that storage directory as `SCAN_STORAGE_DIR`, the
same placeholder Auth0 settings, and `APP_BASE_URL=http://localhost:5173`. Start Vite.
The test uses no authentication bypass; the browser is a signed-out guest. Owner
creation in this fixture runs through multipart parsing and the existing scan service,
while signed-in Auth0 browser uploading still requires a separate manual check.

```sh
cd apps/web
pnpm exec playwright install chromium
TEST_SPACE_URL=http://127.0.0.1:5173/spaces/<spaceId> \
TEST_SAVED_PATH_ID=<pathId> \
TEST_PRIVATE_SPACE_URL=http://127.0.0.1:5173/spaces/<privateSpaceId> \
TEST_PRIVATE_SCAN_ID=<privateScanId> \
TEST_START_NODE_ID=<firstNodeId> TEST_END_NODE_ID=<lastNodeId> \
pnpm test:browser
```

The browser test checks real API downloads, textured model rendering without loader
errors, dynamic/saved routes, orbit/reset, and a second isolated browser context at
phone viewport size. It saves screenshots under ignored `apps/web/test-results/`.
The fixture's known transform is `T(3,0,-2) × Ry(90°) × S(2)`; graph nodes at
`(3,0,-0.5)`, `(3,0,-2)` and `(3,0,-3.5)` run down the first plane. This is a
coordinate implementation check, not evidence about the captured room.

## Acceptance record

Software verification on 21 November 2026:

- Frontend production build and 9 focused GLB/navigation/alignment tests passed.
- API production build, typecheck and PostgreSQL suite passed: 9 tests passed,
  real-file test skipped.
- `make check` passed, including public, unlisted and private legacy mock sharing.
- Chromium smoke passed against the real Next.js routes and disposable PostgreSQL
  in 7.7 seconds. It downloaded two uploaded textured GLBs, displayed a two-segment
  dynamic and saved route, rejected reverse traversal of directed edges, exercised
  orbit/reset and graph visibility, and opened a public event's saved route.
- A fresh browser context at 390×844 opened the public saved route and received
  denial for the private space and private raw GLB. This is a desktop Chromium
  mobile viewport, not a physical phone test. Screenshots showed the checker
  textures and route aligned on the known transformed plane.

The seed exercised multipart parsing and the scan service with a test owner; the
browser used genuine signed-out API reads. An interactive Auth0 login and owner
upload from the frontend remain manual checks after configuring the frontend origin.

The real GLB is still local to Anish's device. Sam explicitly requested continuing
without it. The final real-room rendering, texture quality, route placement, physical
scale and second-device check remain open. Do not describe the synthetic fixture as
that acceptance result. Record the real file's size/hash, coordinate declaration,
transform, baseline measurement if any, node/path IDs, browser/device and observed
results when the capture is available.
