# Metric LiDAR calibration and owner repair

Human owner: Sam. Frontend review: Arielle. Capture verification: Krishna/Anish.
Components: API processing/approval/scan metadata and web Owner tools. No capture
contract changes, CPU algorithm changes, migrations or production data updates.

## Where the declaration travels

1. `CaptureController.swift` configures ARKit gravity alignment. `CaptureBundle.swift`
   exports anchor transforms into scene positions once and declares metres, +Y up,
   right-handed coordinates and column-major camera-to-capture poses. Device IDs are
   machine identifiers such as `iPhone17,1`. The version 1 capture contract validates
   this declaration, file inventory, digests and frame references; it deliberately
   does not contain a `calibrated` field.
2. The CPU processor validates the bundle and preserves its frame while welding and
   simplifying the GLB. Its report retains coordinates, entrance pose, capture UUID,
   manifest digest, triangles, frames and output checksums. The API CPU adapter
   verifies those against the input before publishing immutable outputs.
3. Previously, the worker copied the capture declaration without a calibration flag.
   Approval's strict viewer-coordinate parser could not accept the capture's extra
   convention fields and defaulted calibration to false. Approval also defaulted
   alignment to false. The old editor compounded this by using its alignment
   checkbox as the metric scale flag.
4. The worker now records `calibrated: true` only for the pinned `lidar-cpu`
   `1-contract-v1` pipeline, a native iPhone/iPad machine ID, a non-synthetic known OS,
   and a matching non-mock report with geometry and frames. Approval independently
   derives the same claim from the digest-checked capture and immutable report,
   including for revisions made before this fix. Unit-scale, proper yaw/translation
   transforms preserve that automatic claim. Scaling, shearing, reflecting or tilting
   a scan requires explicit verification of the resulting frame.
5. Approval stores the compact viewer declaration
   `{"units":"metres","upAxis":"Y","calibrated":true}`. For the sole ready GLB in
   a calibrated metric space with no existing navigation graph, it also records
   `alignmentVerified: true` and `alignmentSource: "single-capture"` automatically.
   An explicit `alignmentVerified: false` still opts out. Additional scans retain
   metric scale but need an owner to confirm their placement. Existing graphs keep
   their approval requirement for matching coordinates and explicit alignment.
6. Scan reads, space scan lists and share metadata recheck a `single-capture`
   assertion against all ready GLBs in the space, including private scans hidden
   from that reader. If there is another model, automatic alignment is reported as
   false. No hidden scan IDs or names are returned. Repeated approval and owner PATCH
   responses use the same effective metadata. Owners can explicitly confirm
   multi-scan alignment through Owner tools; this becomes `alignmentSource: "owner"`.
   Changing other metadata does not silently promote automatic alignment to owner
   verification. Existing graph nodes and saved routes are never transformed.
7. Both viewer gates continue to require calibrated metric coordinates and verified
   alignment. `alignmentVerified: true` alone never establishes scale. No NavMesh
   code or route calculations need to change.

This trusts the existing authenticated native capture/CPU handoff. It is not hardware
attestation, an independent distance measurement, or a guarantee about drift,
coverage or walkability. Tracking warnings remain in the capture/report for review;
normal startup tracking warnings do not alter the declared metric frame.
Unknown legacy devices, labelled synthetic bundles, imported GLBs and `mock-lidar`
never receive automatic calibration. In particular the existing mock scan is not
repaired automatically. A calibrated parent space alone cannot calibrate an import.

## New captures: no calibration checkboxes

1. Start the local API against a disposable database and run the worker with
   `CAPTURE_PROCESSOR=cpu` (install its existing dependencies using
   `npm ci --prefix apps/capture/processor` from the repo root). Follow the
   [CPU runbook](lidar-cpu-processing.md) to upload/finalize a real native bundle.
2. Use a calibrated metric parent space and upload the first scan into an otherwise
   empty space. Do not add graph nodes before this check.
3. Approve the completed revision while signed in as its owner, sending only the
   required name and optional visibility:

   ```js
   await fetch(`/api/scan-revisions/${revisionId}/approve`, {
     method: 'POST', headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ name: 'iPhone room', visibility: 'public' })
   });
   ```

   Public requires a public parent space. Leave coordinateSystem/alignmentVerified
   out of the body to use validated defaults. A non-rigid saved transform, another
   scan, an existing graph or an uncalibrated parent requires appropriate owner
   confirmation instead.
4. Open the returned space/share link, enable **Automatic route**, then double-click
   two floor points. Follow the [routing workflow](scan-automatic-routing.md) for
   debug display, errors and second-phone checks.

## Existing scans: supported owner action

In `/spaces/:spaceId`, open **Owner tools → Upload and align scans**, select the
approved scan, and click **Restore validated LiDAR calibration**. The request is:

```js
await fetch(`/api/scans/${scanId}/calibration`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
});
```

It uses the existing Auth0 session or bearer authentication and scan/space access
checks. Anonymous/invalid tokens return 401; a nonowner of a visible scan gets 403;
an inaccessible scan gets 404. Successful repair returns 200 `{scan}` with its ID,
sharing, transform and file references preserved. It changes only scan metadata and
updatedAt, leaving the immutable revision untouched. Opaque/private file routes and
visibility checks remain unchanged. Conflicts return 409 when native provenance,
metric parent or the current unit-scale Y-up transform cannot be established.
Approval retries intentionally preserve prior owner edits; use this action for repair.

For an imported, legacy, synthetic or mock scan, independently check its measured
scale, floor orientation and placement first. Owner tools now have **separate**
scale and alignment confirmations. Check **I independently verified this scan's
metric scale (metres)** only with evidence, confirm placement separately, then save.
The existing owner-only `PATCH /api/scans/:id` remains supported:

```js
// Keep unrelated existing metadata. A deliberate owner alignment assertion is explicit.
const metadata = { ...scan.metadata,
  coordinateSystem: { units: 'metres', upAxis: 'Y', calibrated: true },
  alignmentVerified: true, alignmentSource: 'owner'
};
await fetch(`/api/scans/${scan.id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ metadata })
});
```

Do not run this just because a parent space uses metres or the alignment checkbox
was previously checked. For unknown scale, use the existing two-point measured
calibration tool. Transform edits clear UI verification; an API transform change
without explicit coordinate evidence clears calibration for non-metric transforms.
No SQL updates or bulk backfill are needed or performed.

## Local verification

```sh
npm ci --prefix apps/capture/processor
npm test --prefix apps/capture/processor
# Use only a disposable local test database, migrated with the existing API migrations.
cd services/api
TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:55432/DISPOSABLE_TEST_DB \
  AUTH0_DOMAIN=example.auth0.com AUTH0_AUDIENCE=https://api.not404.test \
  AUTH0_CLIENT_ID=test-client AUTH0_CLIENT_SECRET=test-only \
  AUTH0_SECRET=0000000000000000000000000000000000000000000000000000000000000000 npm test
npm run typecheck
# Build with your local development configuration or placeholder build values; no DB reads required.
npm run build
cd ../../apps/web
pnpm test
pnpm typecheck
pnpm build
NAVMESH_TEST_PORT=5187 pnpm test:navmesh:browser # optional port override; default 5186
cd ../..
make check
```

`calibration.test.ts` runs the real CPU processor, worker, approval, owner repair and
share reads against a disposable PostgreSQL database. It uses synthetic geometry
with simulated native device metadata in a temporary directory to exercise the
validated branch; it does not relabel the checked-in synthetic fixture or claim a
real iPhone trial. It covers mock/import exclusions, unsupported devices, digest
mismatches, changed transforms, owner authorization and a hidden second scan.
Browser API fixtures verify the owner repair control, independent scale/alignment
confirmation and existing doorway routing. All real scan artifacts remain private.
