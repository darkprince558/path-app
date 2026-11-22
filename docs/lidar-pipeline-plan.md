# !404 LiDAR capture and navigation pipeline plan

Planning only; no functionality, schema migrations, or infrastructure changes are included.

Human owner: **Sam**. Capture and CPU processing: **Anish**. Gemini landmarks and verified-route instructions: **Krishna**. 3D frontend and eventual unified mobile app: **Arielle**.

The next verifiable outcome is one physical iPhone LiDAR capture uploaded as a complete bundle, processed into a viewable scan and draft navigation graph, corrected and approved by its owner, then opened on a second phone with a saved route and an approved landmark instruction. Keep **Tiger Data PostgreSQL**, Drizzle migrations, Auth0, and the existing scan, graph, path, destination, event, and sharing experiences.

## 1. Existing functionality we can reuse

This assessment uses branch `feature/lidar-pipeline` at `f6a5e0d` on 21 November 2026. GitHub main was `4141df6`, an ancestor of this branch; the working tree was clean before this document. The [live team board](https://github.com/darkprince558/path-app/issues/8) and open PRs were checked. Capture PR #12, reconstruction PR #19, and later frontend PRs #16/#18/#21 remain separate work; their proposed features must not be assumed to exist here.

| Existing capability | Source and reuse | Current limit |
| --- | --- | --- |
| Durable relational backend | [Schema](../services/api/src/db/schema.ts), [backend plan](backend-plan.md), and [API README](../services/api/README.md): users, spaces, scans, viewer grants, nodes, edges, destinations, saved paths, ordered waypoints, events, membership, and resource links. | No capture bundle, frame, processing job, graph revision, or landmark tables. No reason to replace Tiger Data or introduce hypertables for the MVP. |
| Auth0 and authorization | [API access helpers](../services/api/src/lib/api/access.ts), [scan service](../services/api/src/lib/api/scans.ts), and [event service](../services/api/src/lib/api/events.ts) check identity, parent-space access, scan grants, and event membership. | Event membership can grant access to a private space, but does not alone grant private scan access. New assets and jobs need equivalent server checks. |
| GLB upload and rendering | `POST/GET /api/spaces/:id/scans`, `GET/PATCH/DELETE /api/scans/:id`, and protected `GET /api/scans/:id/file`; [scan contract](scan-api.md). | Multipart upload accepts one GLB up to 32 MiB, buffers it, validates its container and embedded resources, and immediately creates a ready scan. It cannot ingest the agreed multi-file bundle or validate mesh walkability. |
| Storage abstraction | [ScanStorage and local implementation](../services/api/src/lib/storage/index.ts) provide put/get/delete/exists and optional presigning hooks. | The active adapter is development-only local disk. Its key validator accepts only `scans/<uuid>.glb`. Vultr S3 storage, bundle namespaces, streaming transfers, and durable worker integration remain to be built. |
| Coordinates and alignment | [Scan data contract](scan-data-contract.md), scan transforms, coordinate declarations in JSON metadata, and owner alignment tools. | Existing scans may use relative units. Alignment confirmation and navigation locking are frontend conventions; the scan PATCH route does not enforce the lock. LiDAR must add server validation without relabeling old scans as metric. |
| Graph and destinations | `GET /api/spaces/:id/graph`, node/edge POST routes, and destination CRUD. Same-space foreign keys, finite coordinates, positive edge costs, and directionality already exist. | The graph is manually authored. There are no node/edge PATCH or DELETE routes, draft publication, automatic extraction, or revision conflict checks. |
| Routing and saved paths | [Frontend navigation](../apps/web/src/lib/navigation.ts) runs A* with an admissible cost-scaled heuristic, handles disconnected endpoints, and rechecks saved-route adjacency. [Backend path validation](../services/api/src/lib/api/paths.ts) checks ordered same-space node references and allowed edge direction on writes. | The backend does not compute automatic routes. The current A* does not filter `accessible` edges; the field's presence is not an implemented accessibility mode. |
| Viewer, events, and fixture workflows | [Navigation integration](navigation-integration.md), [web README](../apps/web/README.md), `/spaces/:id`, `/events/:id`, and the legacy `/s/:shareId` PLY/GLB viewer. | Next.js accepts public/private visibility only. The database enum includes unlisted and scans have share IDs, but production share resolution is absent. The Python mock supplies the legacy three-mode sharing contract. |
| Gemini design | [Gemini demo](gemini-demo.md) already specifies stable evidence frames, route-derived turn direction, and organizer approval. | This branch has no implemented Gemini analysis endpoint. Coordinate with Krishna's separate Gemini work before adding parallel contracts. |

The older [architecture](architecture.md), [capture README](../apps/capture/README.md), and [roadmap](../planning/ROADMAP.md) contain earlier stack/capture alternatives. This plan adopts the team's new LiDAR direction and ownership while retaining their first real-scan, second-phone milestone. Existing monocular GLBs, PLY mock fixtures, manual routes, public/private reads, and events remain supported.

## 2. Required schema changes

Use additive Drizzle migrations on Tiger Data. Store binary geometry and images in private object storage, with only keys, checksums, metadata, and navigation records in PostgreSQL. Preserve existing IDs and response fields. The following names are proposals, not implemented tables.

| Addition | Proposed fields and constraints |
| --- | --- |
| `captures` | Internal UUID, owner/space IDs, device capture ID, manifest schema version, immutable manifest JSON and checksum, device/capture timestamps, declared coordinate system, entrance pose, tracking warnings, upload state, timestamps. Unique `(owner_id, device_capture_id)` prevents duplicate phone retries; changed content under the same ID returns a conflict. Enforce owner/space consistency. |
| `capture_assets` | Capture ID, stable asset ID, logical bundle path, role, private object key, media type, expected/observed byte size and SHA-256, upload/validation state. Unique `(capture_id, logical_path)` and object key. Use bigint byte counts for new assets; existing scan byte size is an integer and needs an explicit limit or later widening for larger outputs. |
| `capture_frames` | Capture ID and stable source frame ID as a composite unique key, image asset reference, camera-to-capture pose, timestamp, image dimensions, optional intrinsics and quality/tracking fields. Enforce image ownership within the same capture. Store full `frames.json` as an asset as well. |
| `processing_jobs` | Capture ID, job type, input digest, processor/configuration version, attempt count, queued/running/succeeded/failed state, stage/progress, lease/heartbeat, timestamps, safe error code, output references. Unique logical job key for idempotent enqueue; separate attempts and stale-lease recovery. No storage URLs or secrets in errors. |
| Scan provenance | Nullable `capture_id` and successful processing job reference on `scans`; metadata records output version, quality, frame declaration, and alignment evidence. Keep `object_key` as the canonical ready GLB used by `/file`. Legacy scans need no capture backfill. Use a relation for extra derived assets rather than overloading this single GLB key. |
| `graph_revisions` | Space ID, base revision/version, draft/published/superseded state, source captures/jobs, algorithm/config version, immutable draft snapshot asset, creator/reviewer, approval timestamps. Track an active revision and graph version for each space; legacy graphs start as the baseline. |
| Graph provenance and corrections | Nullable source capture/job references and automatic/manual origin on nodes/edges, verification state, stable processor element keys, and a correction log recording revision, author, operation, before/after values, and reason. Corrections cover moving/adding nodes, adding/removing/blocking edges, direction, cost, floor and accessibility. Keep cross-space references impossible. |
| `landmarks` and `route_instructions` | Landmark evidence references stable capture/frame IDs and approved graph nodes. Store draft text, review state, reviewer, model/prompt version, and job provenance. Instructions bind ordered approach/turn/exit node IDs, graph revision, route digest and traversal direction to evidence and approved text. Use join rows for multiple evidence frames. |

For the MVP, stage each draft graph as an immutable JSON asset and materialize only the approved graph into the existing `nav_nodes`/`nav_edges` tables in a transaction. This avoids rewriting every graph consumer around revision-specific tables. The active revision and version still identify exactly what is live. Retain published snapshots for audit and rollback; they are owner-only unless explicitly authorized for a viewer.

Preserve unchanged node IDs when publishing. A removed node referenced by a destination or path must be remapped explicitly or publication must return 409. Revalidate all saved paths against changed edges and directions before publication; reject changes that invalidate them until the owner repairs the affected paths. Do not silently rewrite routes. Node movement also requires instruction regeneration/reapproval when it changes the turn. Any rollback uses the same checks.

Backfill existing graphs as approved legacy data without changing coordinates. Keep scan status `pending/ready/failed`; detailed capture processing states belong to captures/jobs, so a failed new run never makes an already published scan unavailable. Add indexes for owner/space lookup, queued jobs, capture-frame identity and revision lookup. Generate/review SQL with the documented Drizzle workflow; do not use schema push against the shared database.

## 3. Required API endpoints

Preserve all current endpoints. These are proposed additions; agree request/response examples with Anish, Krishna and Arielle before implementation. Use the existing JSON error envelope, Zod validation and Auth0 session/bearer authentication. Inaccessible IDs return 404. Owner mutations verify the parent space and every referenced child on the server.

| Proposed route | Behavior and access |
| --- | --- |
| `POST /api/spaces/:id/captures` | Owner registers a manifest and file inventory; returns capture ID, expected assets, upload state and scoped upload targets. Idempotency key/device capture ID plus manifest digest resolve retries to one capture. |
| `GET /api/captures/:id` | Owner polls upload/processing state, missing/invalid assets, warnings, latest jobs and resulting scan/draft revision IDs. No raw object keys in the response. |
| `POST /api/captures/:id/upload-urls` | Owner renews short-lived upload targets for specified incomplete assets. Server selects keys and checks content type, size and declared checksum. Add a bounded development upload endpoint when using local storage. |
| `POST /api/captures/:id/complete` | Owner finalizes one immutable inventory. Checks all bytes and metadata, then durably enqueues processing once; returns 202 with job/status link. Duplicate completion returns the same logical job/result. |
| `GET /api/processing-jobs/:id` | Owner reads bounded progress, warnings and safe failures. Internal workers use service credentials, not public mutation endpoints. |
| `POST /api/captures/:id/reprocess` | Owner creates a versioned job for a specific immutable input/configuration. Same key is idempotent; new versions produce separate outputs and drafts. |
| `DELETE /api/captures/:id` | Owner cancels unfinished work and schedules staged-object cleanup. Reject deleting captures still referenced by published scans, graphs or landmark evidence until dependencies are removed or retained explicitly. |
| `GET /api/captures/:id/assets/:assetId/file` | Owner-only original manifest, PLY, source GLB, frames and preview reads. A separate approved image endpoint can expose explicitly published evidence after checking current parent-space, scan and image permissions. |
| `GET /api/spaces/:id/graph/revisions` and `GET /api/spaces/:id/graph/revisions/:revisionId` | Owner inspects draft proposals, provenance and differences; published consumer graph remains available through the current graph GET. |
| `PATCH /api/spaces/:id/graph/revisions/:revisionId` | Owner submits a batch of validated correction operations against an expected version. Apply atomically, record audit data and return 409 on stale versions. This supplies missing move/remove/block operations. |
| `POST /api/spaces/:id/graph/revisions/:revisionId/publish` | Owner approves a validated draft, applying the saved-path/destination checks and active-version comparison in one transaction. Returns the new active graph version. |
| `POST /api/spaces/:id/routes` | Computes a route on the current authorized published graph from start node to destination/node; returns ordered nodes, distance/units, graph version and route digest, or a structured no-route result. Honor directed/blocked edges and requested supported constraints. Share the algorithm/fixtures with frontend A* to avoid contradictory results. |
| `POST /api/captures/:id/landmark-analyses` | Owner requests Gemini analysis of selected existing frame IDs associated with verified nodes. Returns a job; Gemini output cannot insert geometry or edges. |
| `GET/PATCH /api/landmarks/:id` | Owner reviews evidence and accepts, edits or rejects a suggestion. Published approved labels may have a viewer response with stricter evidence filtering. |
| `POST /api/spaces/:id/route-instructions` | Revalidates the supplied ordered route against the active graph, computes turn facts deterministically and asks Gemini to phrase grounded instructions. Return draft text linked to route/version/evidence. Cache by route, graph and approved landmark versions. |
| `PATCH /api/route-instructions/:id` and authorized instruction GET | Owner accepts/edits/rejects; guests receive only currently approved, non-stale instructions for an accessible route. |

Keep the current node/edge POST routes for manual maps, but make all graph writes advance the graph version and use the same validation/invalidation rules. A draft based on an earlier version cannot publish over newer manual edits. Ordinary destination/path CRUD continues to work.

The production unlisted gap is a separate compatibility requirement for the first sharing milestone: implement opaque share resolution, authorized metadata/assets and discovery filtering while preserving `/s/:shareId` and the mock's `shareId`, `sharePath`, `assetPath` semantics. Coordinate viewer grants and map-management routes with Arielle's open branches. Do not merely allow `unlisted` in Zod: parent-space, graph, path, frame and direct asset access need a coherent scoped-link policy first. Public events must never widen a private scan's audience.

## 4. Capture upload and processing architecture

### Bundle and coordinate contract

The agreed input is:

```text
manifest.json
source.glb
points.ply
frames.json
frames/<stable-frame-id>.jpg
preview.jpg
```

The manifest records capture ID, device, coordinate system, entrance pose, file checksums and tracking warnings. Frames retain stable IDs and camera poses. Propose a versioned manifest with byte sizes and SHA-256 for every other file; hash the manifest separately at registration to avoid a self-checksum cycle. Register the whole inventory before issuing upload targets. Keep the original bundle immutable, including tracking warnings.

Anish and Sam must agree whether GLB scene coordinates, PLY points, frame poses and entrance pose already share one capture frame; whether poses are camera-to-world or world-to-camera; matrix storage; camera forward axis; and whether an export transform has already been baked into geometry. Include intrinsics/image orientation if projecting landmarks. Do not assume the old monocular export convention applies to ARKit.

Retain the existing space contract: Y-up, column-major affine matrices, with `scan.transform` mapping the exported scene into the space. Prefer measured metric LiDAR output, but verify scale and orientation against the room before setting alignment verified. Preserve relative-unit legacy spaces; do not mix metric points into them without explicit conversion. For the proposed common capture frame:

```text
p_space = M_capture_to_space × p_capture
M_camera_to_space = M_capture_to_space × M_camera_to_capture
```

The export adapter must account for glTF node transforms once. Graph nodes and entrance nodes are stored in space coordinates; the viewer never applies an individual scan transform to them again.

Before code changes, exchange a small synthetic bundle: identity alignment, entrance `(0,0,0)`, junction `(0,0,-4)`, destination `(-3,0,-4)`, and frames `approach-01`/`junction-02` with explicit poses. Expected graph follows the verified floor around the left turn; include an obstructing wall and a disconnected area to test rejection. This is a proposed contract example, not real capture evidence. Then repeat with a nonidentity scan transform to expose double transformation.

### Upload, work queue and publication

1. **Register and stage.** Auth0 identifies the uploader; Sam creates the capture and inventory in Tiger Data. Objects use server-generated private staging keys scoped to capture/asset IDs. Do not trust filenames as paths or accept arbitrary URLs. Use direct, resumable object transfers for large bundles, not a larger version of the current buffered multipart handler. Verify provider support for multipart/checksums before depending on it. Keep the existing small GLB route unchanged.
2. **Validate completion.** Check required files, allowed paths, inventory limits, actual sizes and hashes, GLB/PLY/JPEG parseability, finite/invertible poses, frame uniqueness/references and declared coordinate consistency. Header checks alone are insufficient. Tracking gaps become visible warnings and may require recapture; missing or corrupt files do not enter processing. Freeze accepted inputs or copy verified object versions so an old upload URL cannot replace bytes after verification.
3. **Enqueue durably.** The completion transaction creates a queued job in PostgreSQL; a separate CPU worker claims it with a lease and heartbeat. Start with a PostgreSQL-backed queue; Redis/GPU infrastructure is unnecessary for this MVP. A worker can initially run on Anish's machine against approved inputs, then on the deployed host. Do not run long processing inside a Next.js request.
4. **Process deterministically.** Anish supplies a versioned CPU processor and machine-readable input/output contract. Validate/clean mesh and point cloud, identify floor and obstacles, build a walkable representation, then extract route nodes/edges and entrance connections. Use slope, clearance, step height and unknown-area rules chosen with physical evidence. Record parameters, algorithm version, warnings and quality metrics. Camera trajectory helps identify observed areas but is not proof of walkable clearance. No edge may shortcut through a wall or an unobserved gap. Start with one floor; stairs/elevators require explicit verified connectors later.
5. **Write candidate outputs.** Write a mobile-friendly embedded-resource GLB, graph proposal, processing report and optional derived preview under immutable job-specific keys. Reuse the supplied GLB when appropriate; do not require reconstruction of already usable LiDAR geometry. Retain source PLY and frames privately. Store only references and provenance in Tiger Data. A successful mesh can be viewable even when graph extraction fails; expose separate geometry and routing outcomes.
6. **Review and publish.** Sam registers a validated viewer-ready GLB as an existing scan, initially private and unverified. Arielle displays the draft graph for manual corrections. Owner confirmation checks alignment, entrance, turns and traversability; publication atomically activates the approved graph. A job can finish successfully without publishing a graph. Gemini and public sharing are separate approval steps.
7. **Recover and clean up.** Use at-least-once job delivery with idempotent output registration, bounded retries, stage-specific failures and stale-lease recovery. A crash between storage writes and DB registration leaves reclaimable objects. A failed reprocess retains the previous ready scan and approved graph. Expire incomplete uploads and orphaned outputs after a documented retention period; never collect objects still referenced by published content. Deletion cancels/invalidates jobs so late workers cannot recreate removed data.

Extend the storage adapter with controlled capture/output namespaces, streaming/metadata operations and a Vultr S3-compatible implementation. Keep buckets private. Current `/file` rechecks access on every GET and uses `private, no-store`; preserve that behavior. A presigned download remains usable until expiry, so do not claim immediate revocation if redirects replace proxy reads. Original camera frames stay owner-only by default, even when a derived scan is public. Never expose object keys through arbitrary metadata copied into public scan responses.

## 5. Integration points with existing scans and navigation

- **Capture producer:** Anish exports the agreed bundle and owns the CPU mesh/walkability processor. LiDAR is the new primary capture path; existing RGB reconstruction and imported GLBs remain valid imports, without retroactive metric claims.
- **Backend:** Sam owns registration, checksums, storage, worker orchestration, additive migrations, publication and access control. Capture IDs identify immutable inputs; scan IDs identify renderable outputs; job/revision IDs identify processing and graph history. Do not use filenames as resource identities.
- **Viewer:** Arielle keeps consuming `scan.downloadPath`, format and transform through the current protected GLB routes. Add capture progress and draft graph review to owner tools. Guests see approved active navigation. Preserve textures, combined bounds, existing manual authoring, saved routes and event links. Unified mobile clients can reuse the bearer-auth API; a frontend rewrite is not a prerequisite.
- **Alignment:** Keep `space.boundary.coordinateSystem` and `scan.metadata.coordinateSystem` conventions. Enforce server-side locks when scans have referenced navigation or approved evidence. Changing alignment requires a new draft and coordinated updates of affected graph/frame/landmark coordinates, never a scan-only transform patch. Current arbitrary metadata PATCH must not be able to forge server-controlled processing/provenance fields.
- **Route correction:** Preserve owner edits as explicit overrides. Reprocessing creates a new proposal against a base version; replay compatible corrections using stable element keys and show conflicts for review. Never replace the live graph or lose a blocked edge automatically. Existing saved paths retain their IDs and ordered nodes; publications that break them require explicit repair.
- **Automatic pathfinding:** Geometry creates candidate walkability; approved graph edges remain authoritative for A*, server routing and saved-path validation. Keep unreachable states and one-way handling. Use QR/manual start selection for MVP; frame poses do not supply live phone localization. Nearest-node snapping alone cannot prove the joining segment is walkable.
- **Landmark instructions:** Krishna receives selected frames, stable frame IDs, camera poses and verified graph/route facts. Gemini identifies visual landmarks and phrases already computed turns; it cannot invent coordinates, destinations, walkable edges or turn direction. Validate returned IDs and evidence against the same capture/revision. Bind instructions to travel direction, review them, and invalidate them after relevant graph/alignment/landmark changes. Plain deterministic directions and manual labels remain available when Gemini fails or abstains.
- **Access composition:** Reading a public graph must not reveal original private frames or capture metadata. Before publishing approved image/text derivatives, the owner must explicitly approve their audience. A landmark derived from a private scan is not automatically public because its space is public. Enforce current parent-space, scan and derivative permissions on every read, including event-linked requests and direct URLs.

## 6. Implementation phases

| Phase | Owner and affected components | Verifiable acceptance |
| --- | --- | --- |
| 0. Freeze one producer/consumer example | Anish + Sam + Krishna + Arielle; capture/processor/API contracts and synthetic fixtures. | All consumers agree on inventory, stable IDs, poses, transform order, output graph and error shape. A measured physical LiDAR capture confirms the convention; record device, tracking warnings and checksum without committing private captures. |
| 1. Add capture persistence and upload | Sam; `services/api` schema/migrations, storage and capture routes. | Complete one bundle, retry interrupted files and completion, reject a wrong hash/missing frame, restart the service and resolve the same capture. Exercise owner/nonowner access. Existing direct GLB and legacy fixture workflows still pass. |
| 2. Connect CPU processing | Anish processor + Sam worker. | One bundle produces a ready GLB and draft graph with versioned report. Repeated delivery registers one logical result. Demonstrate worker crash/retry and malformed input; earlier published content remains usable. |
| 3. Review, correct and route | Sam + Arielle; graph revision APIs and editor. | Correct a false wall-crossing edge, move/add a waypoint, set one-way travel and publish. Automatic and saved routes agree; disconnected destinations fail cleanly. Stale publication returns 409; reprocessing preserves corrections; referenced paths/destinations are protected. |
| 4. Ground Gemini instructions | Krishna + Sam + Arielle; analysis/review APIs and UI. | Generate and approve one recognizable turn with stable frame evidence. Reverse travel uses its own turn facts; unknown frame IDs are rejected; blank evidence can yield no suggestion. Route changes hide stale instructions; Gemini failure leaves navigation available. |
| 5. Deploy, complete sharing and test phones | Sam storage/API + Arielle viewer + Anish capture + Krishna cues. | Private Vultr objects persist across restart. Exercise public, unlisted and private metadata, graph, image and raw asset reads, including grants/revocation. An unlisted real scan opens signed out on a second physical phone. Record bytes, upload/processing/load times, device/browser, alignment, actual walked route and instruction usefulness. |

Run the existing affected-component checks during implementation: API typecheck/tests/build against a disposable migrated PostgreSQL database, frontend tests/build/browser smoke, and root `make check` for upload/sharing/fixture changes. Add focused pipeline tests for checksums, idempotency, worker recovery, graph publication and evidence authorization. Existing synthetic browser results in the navigation runbook are software evidence, not physical-phone or LiDAR accuracy evidence.

Open integration decisions: final ARKit/export pose convention and entrance semantics; processor format/version and CPU resource budget; minimum observed clearance/quality and recapture thresholds; provider transfer limits and private-frame retention; scoped unlisted access across parent/child resources; and Krishna's current Gemini branch contract. Resolve these with the named owners before implementing the corresponding phase. This plan does not finalize those cross-component contracts or claim real-device verification.
