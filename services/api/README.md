# Upload and sharing API

The implemented space, graph, destination, saved-path and event routes are documented in [Core API contract](../../docs/core-api.md).
Local GLB upload, metadata and authorized download routes are documented in [Scan API contract](../../docs/scan-api.md).
LiDAR registration, per-file upload and finalization are documented in the [Capture API contract](../../docs/capture-api.md).
The [processing worker runbook](../../docs/capture-processing.md) covers queued jobs,
`GET /api/jobs/:jobId`, mock outputs, immutable revisions and restart recovery.
The [real CPU workflow](../../docs/lidar-cpu-processing.md) covers selecting Anish's
CLI, installing its dependencies and processing one uploaded capture by job UUID.
The [publishing runbook](../../docs/lidar-publishing.md) covers revision approval,
protected share assets and the complete Task 5 local workflow.

## Metric scan calibration

Validated native CPU captures preserve metre calibration through approval. A sole
scan in an empty calibrated metric space needs no manual alignment checkbox.
Owners can repair older approvals with `POST /api/scans/:id/calibration` (`{}`),
or use separate measured-scale/alignment confirmations for imports and mocks.
See [calibration policy, provenance trace and local tests](../../docs/scan-calibration.md).

## Auth0 login shell

The Next.js App Router shell and official Auth0 SDK live in this package. Copy `.env.local.example` to `.env.local` here, then fill in `AUTH0_CLIENT_SECRET` from the Auth0 application and generate `AUTH0_SECRET` locally with `openssl rand -hex 32`. The domain, client ID and base URL in the example match the configured Regular Web Application. For API-only development use `APP_BASE_URL=http://localhost:3000`; the registered callback is `http://localhost:3000/auth/callback` and logout URL is `http://localhost:3000/`. Do not commit `.env.local` or put secrets in `NEXT_PUBLIC_` variables.

```sh
cd services/api
cp .env.local.example .env.local
# Fill AUTH0_CLIENT_SECRET and AUTH0_SECRET in .env.local locally.
npm ci
npm run dev
```

Open `http://localhost:3000`, then use Sign up or Log in. The SDK handles `/auth/login`, `/auth/callback` and `/auth/logout`; the home page reads the server session and shows the signed-in identity. Google sign-in requires enabling the Google connection in Auth0.

Set `AUTH0_AUDIENCE=https://api.not404.app` in `services/api/.env.local`, matching the Auth0 API identifier exactly; the API must use RS256 signing. In the Auth0 API's Application Access settings, authorize the regular web application for user-delegated access. Restart `npm run dev` after changing environment variables. The SDK requests this audience on login. `GET /api/users/me` accepts either the SDK session cookie or an `Authorization: Bearer <access-token>` header, verifies the API access token against Auth0's keys and claims, then upserts the `users` row by `auth0_sub`. A missing or invalid token returns 401. The response is `{ "user": { "id", "username", "displayName", "createdAt", "updatedAt" } }`. Other resource routes must call the same authentication helper and apply owner or membership checks before returning data. The SDK's browser access-token endpoint is disabled; client secrets stay server-side.

## Stage 1 database foundation

The TypeScript database package is ready for later Next.js route handlers. It does not replace the Python reference API below yet. Requires Node.js 22+ and a PostgreSQL database. For Tiger Data, use its dashboard's PostgreSQL connection URI with TLS. Do not paste the URI into Git or agent prompts.

```sh
cd services/api
npm ci
cp ../../.env.example .env
# Edit .env: replace DATABASE_URL with the Tiger Data URI.
npm run typecheck
npm run db:check
npm run db:ping
npm run db:migrate
npm run db:seed
```

`db:ping` checks connectivity without changing data. `db:migrate` applies the committed migration once; `db:seed` inserts an idempotent synthetic corridor with four nodes, three edges, two destinations, a saved path and an event. The sample scan is a private, pending placeholder with no object storage bytes. It is only for local or disposable databases; do not seed a production database. The seed user has a fake `seed|organizer` Auth0 subject.

For later schema changes, edit `src/db/schema.ts`, run `npm run db:generate`, review the SQL and commit it with the schema. Avoid `drizzle-kit push` on shared databases. `updated_at` defaults on insert; later write handlers must update it explicitly. The [backend plan](../../docs/backend-plan.md) tracks the remaining phases and authorization contract.

The seed should match the [venue fixture](../../fixtures/README.md): entrance `(0,0,0)`, junction `(0,0,-4)`, workshop `(-3,0,-4)`, booth `(3,0,-4)`. The graph is a manually declared route, not inferred from geometry.

## LiDAR database foundation

Migration `0002_lidar_capture_foundation.sql` adds `captures`, `capture_frames`,
`processing_jobs`, and `scan_revisions`. It uses the existing Tiger Data PostgreSQL
connection through `DATABASE_URL`; no new database service or extension is required.
The schema migration itself does not add workers, publication behavior or access grants.
The capture ingestion routes now register and verify bundles; see the capture API
contract above. Finalization now enqueues one job for the separate mock processing
worker; existing scans/graphs remain unchanged. Review and manually apply migration
`0003_durable_capture_processing.sql` before using the worker.

- Captures store manifest inventory/checksum, device, entrance pose, coordinate declaration,
  tracking warnings and upload state. `(owner_id, device_capture_id)` identifies retries;
  the capture must belong to a space owned by that user. Source bytes remain in storage.
- Frames use `(capture_id, frame_id)` as their stable identity, with image object key,
  checksum, camera pose and optional intrinsics/dimensions. The manifest retains the
  complete asset inventory; a separate assets table is deferred.
- Jobs record a capture-scoped idempotency key, input digest, processor version/configuration,
  integer progress from 0 to 100, retries and lease metadata. Queueing/execution is deferred.
- Revisions store candidate GLB and optional graph object keys, digest, transform and
  draft/approved/rejected/superseded state. The processing job must reference the same
  capture; an optional existing scan link must belong to the same space. Approval requires
  both an approving user and timestamp. Approval alone never changes the live scan/graph.

Existing rows require no backfill. The only changes to existing tables are composite
unique constraints on `spaces(id, owner_id)` and `scans(id, space_id)` for the new foreign
keys. Linked jobs/revisions restrict deletion to preserve provenance; deleting a capture
without these dependencies cascades to its frames. Future write handlers must enforce
owner approval, immutable completed inputs, state transitions, safe object keys, finite
affine matrices and coordinate conventions. SQL currently checks matrix array length,
not every element or physical alignment. Revision `metadata.evidenceFrameIds`, when used,
must be validated against that revision's capture frames; metadata is not a foreign key.
These internal records must not be returned through public scan metadata.

Generate and validate locally (these commands do not apply migrations):

```sh
cd services/api
npm run db:generate -- --name=lidar_capture_foundation
npm run db:check
npm run typecheck
```

The generated migration and snapshot are already included. After reviewing SQL, apply
pending migrations **manually** using the existing configured Tiger Data connection:

```sh
cd services/api
npm run db:migrate
```

Do not run the synthetic seed or integration tests against the remote database.
For local verification, migrate a disposable PostgreSQL database and run `npm test`
with `TEST_DATABASE_URL` pointing to it, as described in the core API contract. The
LiDAR schema test exercises retry uniqueness, ownership/space isolation, frame data,
job constraints, approval completeness and preservation of an existing scan.

## Browser GLB uploads

`POST /api/scans?format=glb&visibility=unlisted&name=Hallway` accepts raw
`application/octet-stream` GLB bytes under the authenticated browser session.
Visibility defaults to private; names default to `Untitled map`. The body is limited
to 32 MiB, including requests without Content-Length. Next.js proxy buffering is
set to 34 MiB so the default 10 MB buffer does not truncate valid uploads. PLY imports return 415.
A successful upload returns 201 `{id, shareId, sharePath, name, visibility}`.

Each browser import gets its own unlisted containing space. Its scan controls
public discovery and private/unlisted/public reads. Unlisted maps open signed out
from their opaque link and stay out of both scan and space discovery. Private
maps require ownership or a viewer grant. Changing visibility through
`PATCH /api/scans/:id` rechecks access on the next metadata and asset request.
The returned `id` is used for edits; `shareId` is used for guest links.
No database migration is needed; the existing visibility enum includes unlisted.

## Python integration mock

Sam owns the durable backend. The team can integrate against the local reference API now with Python 3.9+ and Make. From the repo root, run `make dev-api` in one terminal, then upload the fixture from another.

```sh
curl --fail-with-body -sS \
  -H 'X-Dev-User: demo-owner' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @fixtures/venue/scene.ply \
  'http://127.0.0.1:8001/api/scans?format=ply&visibility=unlisted&name=Engineering%20building'
```

The response includes `shareId` and `sharePath`. Open `http://127.0.0.1:8001` followed by that path in another browser on the same computer. The development page links to the exact uploaded bytes. Arielle’s guest page will use the metadata and asset endpoints below to render the model.

| Request | Behavior |
| --- | --- |
| `POST /api/scans?format=ply&visibility=unlisted&name=…` | Send raw bytes. Accepts `ply` or `glb`. Visibility defaults to `private`. `name` is optional (default `Untitled map`). Returns 201 with `{shareId, sharePath, name}`. |
| `GET /api/scans/public` | Returns `{scans: [{shareId, sharePath, name, updatedAt}]}` for public discovery, newest first. No sign-in needed. |
| `GET /api/scans/mine` | The signed-in account's own maps, newest first: `{scans: [{shareId, sharePath, name, format, visibility, viewerIds, updatedAt}]}`. 401 when signed out. |
| `GET /api/scans/shared` | Maps other accounts added the signed-in account to: `{scans: [{shareId, sharePath, name, format, visibility, owner, updatedAt}]}`, without anyone's viewer list. 401 when signed out. |
| `GET /api/shares/<shareId>` | Returns `{shareId, format, assetPath, name}` to a permitted viewer. |
| `GET /api/shares/<shareId>/asset` | Returns the uploaded file after the same access check. |
| `PATCH /api/scans/<shareId>` | Owner sends JSON with any of `name`, `visibility` and `viewerIds`. Fields left out keep their value. `viewerIds`, when sent, is the complete replacement list. Returns `{shareId, name, visibility, viewerIds}`. |
| `DELETE /api/scans/<shareId>` | Owner only. Returns 204, removes the stored file, and every route for that share then answers 404. Anyone else gets 404. |

Names are 1–80 characters after trimming and collapsing spaces, with no control characters. Invalid names get 400. `updatedAt` is an ISO 8601 UTC time that changes on upload and on every `PATCH`.

To grant private access, send `{"visibility":"private","viewerIds":["teammate"]}` as the owner. Repeat with an empty list to revoke access. To rename, send `{"name":"Library study rooms"}`. The smoke test covers these changes, partial changes, the owner and shared lists, deletion, the raw asset URL, and unauthenticated discovery.

The mock binds to loopback, uses `X-Dev-User` to simulate an account, checks file headers, limits uploads to 32 MiB, and discards data on exit. On the hosted API derive identity from a verified session, validate the uploaded model, persist grants, and enforce visibility on every read. Use the deployed site’s origin for portable share URLs. [Architecture and data model](../../docs/architecture.md)

## React authentication and production

The React website uses this backend’s `/api/users/me` session and `/auth/*` routes. For Vite use `APP_BASE_URL=http://localhost:5173`; production uses `https://not404.vodka`. See the [Auth0 production runbook](../../docs/auth0-production.md) for Dashboard settings, verified results, deployment approval gates and outstanding VM inspection. `npm start` binds to `127.0.0.1:3000`.
