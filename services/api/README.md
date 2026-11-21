# Upload and sharing API

The implemented space, graph, destination, saved-path and event routes are documented in [Core API contract](../../docs/core-api.md).
Local GLB upload, metadata and authorized download routes are documented in [Scan API contract](../../docs/scan-api.md).

## Auth0 login shell

The Next.js App Router shell and official Auth0 SDK live in this package. Copy `.env.local.example` to `.env.local` here, then fill in `AUTH0_CLIENT_SECRET` from the Auth0 application and generate `AUTH0_SECRET` locally with `openssl rand -hex 32`. The domain, client ID and base URL in the example match the configured Regular Web Application. Keep `APP_BASE_URL=http://localhost:3000`; the registered callback is `http://localhost:3000/auth/callback` and logout URL is `http://localhost:3000/`. Do not commit `.env.local` or put secrets in `NEXT_PUBLIC_` variables.

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
It does not add upload APIs, workers, publication behavior or access grants.

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

## Python integration mock

Sam owns the durable backend. The team can integrate against the local reference API now with Python 3.9+ and Make. From the repo root, run `make dev-api` in one terminal, then upload the fixture from another.

```sh
curl --fail-with-body -sS \
  -H 'X-Dev-User: organizer' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @fixtures/venue/scene.ply \
  'http://127.0.0.1:8001/api/scans?format=ply&visibility=unlisted'
```

The response includes `shareId` and `sharePath`. Open `http://127.0.0.1:8001` followed by that path in another browser on the same computer. The development page links to the exact uploaded bytes. Arielle’s guest page will use the metadata and asset endpoints below to render the model.

| Request | Behavior |
| --- | --- |
| `POST /api/scans?format=ply&visibility=unlisted` | Send raw bytes. Accepts `ply` or `glb`; visibility defaults to `private`. Returns 201 with `{shareId, sharePath}`. |
| `GET /api/scans/public` | Returns `{scans: [{shareId, sharePath}]}` for public discovery. |
| `GET /api/shares/<shareId>` | Returns `{shareId, format, assetPath}` to a permitted viewer. |
| `GET /api/shares/<shareId>/asset` | Returns the uploaded file after the same access check. |
| `PATCH /api/scans/<shareId>` | Owner sends JSON with `visibility` and the complete replacement list `viewerIds`. Returns the new sharing state. |

To grant private access, send `{"visibility":"private","viewerIds":["teammate"]}` as the organizer. Repeat with an empty list to revoke access. The smoke test covers both changes, the raw asset URL, and unauthenticated discovery.

The mock binds to loopback, uses `X-Dev-User` to simulate an account, checks file headers, limits uploads to 32 MiB, and discards data on exit. On the hosted API derive identity from a verified session, validate the uploaded model, persist grants, and enforce visibility on every read. Use the deployed site’s origin for portable share URLs. [Architecture and data model](../../docs/architecture.md)
