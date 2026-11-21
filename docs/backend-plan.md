# Backend plan

**Owner:** Sam. **Stage 1 outcome:** the synthetic T corridor can be migrated and seeded in Tiger Data PostgreSQL, then read by a later Next.js API. The actual scan upload and second-phone viewing remain the first integrated milestone.

## Architecture and contracts

Use a single Next.js App Router application with server-only route handlers. PostgreSQL on Tiger Data holds users, access grants, spaces, scans, navigation graphs, saved paths and events. Drizzle ORM and committed Drizzle Kit migrations define the schema; postgres.js connects over the supplied TLS URL. Vultr Object Storage holds private GLB/PLY and image bytes. The server issues short-lived S3 presigned URLs only after checking identity and resource access. Auth0 verifies identity; the database stores its `sub`. Gemini analyzes selected camera frames and proposes landmarks for human confirmation. It never creates coordinates or graph edges.

Spaces own one coordinate frame in metres with +Y up. Scan geometry is stored in object storage; each scan records a 16-number transform into its space. Matrix ordering and final capture format must be agreed with Krishna and Anish before real-scan integration. The current synthetic fixture uses +X right and −Z forward. Graph nodes and edges are explicit walkable data; route calculation in Arielle's viewer uses only authorized, connected spaces. A QR marker or manual selection supplies the MVP start point.

Visibility is `private`, `unlisted`, or `public`, with `private` as the default. Public resources are discoverable; unlisted resources require an opaque link; private resources require ownership, a viewer grant, or event membership where explicitly supported. A public event or path must not expose a private space or scan merely by referencing it. Every metadata, graph and object URL request must recheck effective access server-side. Existing downloaded bytes cannot be revoked. Event rows reference spaces, paths and destinations rather than copying them. Saved paths are ordered node references and may be used outside events.

The database enforces IDs, relationships and same-space graph links. Application code in later phases must enforce ownership, visibility composition, event membership, path connectivity and authorization. No hypertables are needed for the MVP; timestamped contribution history and navigation telemetry can be evaluated after the core workflow works.

## Planned HTTP contract

Use `/api/users/me`; `/api/spaces` and `/api/spaces/:id/map`; `/api/scans/upload-url`, `/api/scans`, `/api/scans/:id/download-url`; `/api/spaces/:id/graph`; `/api/destinations`; `/api/paths` and `/api/paths/:id`; `/api/events`, `/api/events/:id`, `/api/events/:id/join`; `/api/scans/:id/analyze`. Add update/delete routes when needed. Validate request bodies with Zod and return consistent JSON errors, for example `{ "error": { "code": "FORBIDDEN", "message": "..." } }`. Preserve the current mock's `shareId`, `sharePath`, and authorized `assetPath` semantics when replacing it.

## Implementation checklist

- [x] **Phase 1 — Database:** Drizzle schema, committed migration, synthetic fixture seed, connection check, database setup instructions. Live Tiger Data connectivity awaits the instance URL.
- [x] **Phase 2 — Authentication:** Auth0 SDK login shell, API audience, JWT verification, user sync and owner/event-member helpers. Real login and Tiger Data profile sync verified by Sam.
- [ ] **Phase 3 — Storage:** development-only local GLB storage, direct upload/download, scan metadata and byte validation are implemented. Private Vultr bucket and presigned transfer await service availability. See [Scan API contract](scan-api.md).
- [x] **Phase 4 — Core APIs:** Zod-validated space, graph, destination, path, event and scan operations, access checks and example requests are implemented. See [Core API contract](core-api.md) and [Scan API contract](scan-api.md).
- [ ] **Phase 5 — Integration:** real capture transform and format, 3D viewer, connected pathfinding, event sharing, second-phone test.
- [ ] **Phase 6 — Gemini:** selected-frame analysis, structured landmark suggestions, human confirmation, optional directions from verified routes.
- [ ] **Phase 7 — Deployment:** Docker on Vultr Cloud Compute, HTTPS, secrets, complete demo walkthrough.

## Existing repo and migration boundary

The original repo had no Next.js package, database client or prior migration. Stage 1 added Drizzle under `services/api/`; the Auth0 login shell now uses Next.js there as well. `tools/scan_mock.py` remains an in-memory Python reference API with `X-Dev-User` and process-local bytes, not the hosted backend. `docs/architecture.md` still describes the earlier open stack choice, including a Supabase option. The chosen stack in this plan supersedes that option. The fixture and mock remain useful for integration until the server routes replace them. The placeholder scan seed is `pending` and has no object in Vultr.
