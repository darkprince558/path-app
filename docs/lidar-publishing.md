# LiDAR publishing and viewer integration

Human owner: Sam. Frontend: Arielle. Capture/processor: Anish. Task 5 connects
[ingestion](capture-api.md) and [processing](capture-processing.md) to approval and
the existing GLB viewer. Processing remains a synthetic mock. No NavMesh, Gemini,
mobile migration, graph generation or existing-model replacement is implemented.

## Approval

`POST /api/scan-revisions/:revisionId/approve` requires the existing Auth0 session
or bearer token and ownership of the capture and parent space. Example body:

```json
{
  "name":"West hallway",
  "visibility":"private",
  "transform":[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
  "coordinateSystem":{"units":"metres","upAxis":"Y","calibrated":false},
  "alignmentVerified":false
}
```

Only name is required. Visibility defaults to private; transform defaults to the
revision matrix; coordinates retain the revision declaration without inferring
calibration. Alignment defaults to unverified. Flags record owner assertions,
not processor accuracy. Public scans require an already public space.

First approval returns 201 `{scan,sharePath}`; retries return 200 with the same scan
and link, preserving any later scan edits. Use existing scan PATCH for those edits.
A revision needs an uploaded capture, completed successful job, matching input
digest, and all required outputs plus any optional PLY verified against immutable
checksums. Failed/rejected/superseded/incomplete revisions return 409. Nonowners get
404. Invalid input/matrices return 400; unauthenticated approvals return 401.

Approval creates a new normal ready GLB scan with a private viewer copy of scene.glb.
The row and revision approval/reviewer/timestamp commit together. Migration
`0004_approved_revision_scans.sql` adds unique nullable `scans.source_revision_id`:
scan/share → immutable revision → job/capture → space. The revision's ID, files,
transform and provenance remain unchanged; its older immutable scan_id is not
rewritten. Manual uploads keep source_revision_id null and retain existing behavior.

For spaces with existing graph nodes, approval requires explicit alignment
confirmation and coordinates matching that space, including metric calibration.
This prevents adding an unverified model from hiding existing navigation. Approval
never rescales nodes, edits edges, changes saved path IDs/waypoints or modifies events.

## Retrieval and privacy

| Endpoint | Behavior |
| --- | --- |
| `GET /api/shares/:shareId` | Top-level viewer metadata: IDs, name, format, assetPath/scenePath, optional pointsPath, transform and safe coordinate/alignment metadata. No raw keys or frame IDs. |
| `GET /api/shares/:shareId/scene` | Authorized GLB bytes. |
| `GET /api/shares/:shareId/points` | Authorized processed scene.ply; 404 if absent or a manual scan. |
| `GET /api/shares/:shareId/frames/:frameId` | Original JPEG for the capture/scan owner only. Public viewers and scan invitees receive 404. |
| `GET /api/shares/:shareId/asset` | Compatibility alias for scene. |
| Existing `GET /api/scans/:id/file` | Continues serving manual and approved processed GLBs. |

Every read rechecks scan and parent-space access. Processed scans also require
current revision approval by the capture owner and a successful matching job.
Private scans still require owner/viewer grants plus parent-space access; event
membership alone never grants private scan access. Public spaces do not reveal
private scans. Making either resource private blocks the next unauthenticated read.
All successful metadata/assets use private/no-store caching.

Camera frames are owner-only even for public scenes; Task 5 adds no public-frame
opt-in. Scene copies, points and frames are checked against their source digests.
Fixed filenames, server-selected keys, strict frame IDs and symlink checks prevent
arbitrary reads. Revoked/unapproved revisions are denied through share and scan APIs.
Already downloaded bytes cannot be revoked.

The guest viewer now passes the saved transform to the existing GLB renderer.
Legacy mock metadata without transforms still uses identity. The space viewer's
downloadPath contract is unchanged. Legacy mock PLY/unlisted sharing still works
against the mock; this task does not introduce production unlisted grants or change
the core public/private policy.

Deleting a published scan removes its viewer copy/link while retaining immutable
revision originals. Explicit reapproval can create a new viewer record. Filesystem
and DB commit ambiguity may leave private orphans; cleanup remains future work.

## Complete local Auth0 workflow

Use the API/web READMEs to configure the Auth0 callback for `http://localhost:5173`.
Set TEST_DATABASE_URL to a disposable local PostgreSQL URI. Review migrations first;
remote Tiger Data migrations are never applied automatically.

```sh
# services/api: apply migrations only to the explicitly selected local database
DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate

# services/api, terminal 1:
DATABASE_URL="$TEST_DATABASE_URL" APP_BASE_URL=http://localhost:5173 npm run dev

# services/api, terminal 2, using the same private storage settings:
DATABASE_URL="$TEST_DATABASE_URL" npm run worker:captures

# apps/web, terminal 3:
API_TARGET=http://127.0.0.1:3000 pnpm dev
```

1. Open `/spaces` on the frontend origin, sign in and create a space. Follow the
   directory-picker example in capture-api.md to register/upload the committed
   synthetic bundle to that space and finalize it. Keep the returned job ID.
2. Poll job.statusPath. Once succeeded, approve its revision from the same signed-in
   browser console (replace jobId with the returned UUID):

   ```js
   const {job} = await fetch(`/api/jobs/${jobId}`).then(r => r.json());
   if (job.status !== 'succeeded') throw new Error('Wait or inspect saved errors');
   const response = await fetch(`/api/scan-revisions/${job.revisionId}/approve`, {
     method:'POST', headers:{'Content-Type':'application/json'},
     body:JSON.stringify({name:'Approved synthetic scan'}) // private default
   });
   const approved = await response.json();
   if (!response.ok) throw approved;
   console.log(approved.scan.downloadPath, approved.sharePath);
   ```

3. Open sharePath and refresh `/spaces/:id`. Use existing alignment tools before
   adding graph nodes. Match coordinates/calibration before showing routes. For a
   space that already has navigation, pass the verified transform, coordinateSystem
   and alignmentVerified:true in approval; otherwise it returns 409.
4. For signed-out viewing, explicitly make the space and scan public using the
   existing owner APIs/tools. Open a fresh browser session: scene/optional points
   load, but `/frames/junction-02` remains 404. Repeat private metadata, scene,
   points and `/api/scans/:id/file` reads; guests must be denied.

API, worker and viewer must use the same DATABASE_URL, SCAN_STORAGE_DIR,
CAPTURE_STORAGE_DIR and REVISION_STORAGE_DIR. Their defaults are private local
directories under services/api when launched there. Keep originals out of Git.

## Repeatable synthetic browser verification

The helper below accepts only a migrated localhost test/stage1 database. It runs
actual ingestion → mock worker → approval services, creates unique synthetic rows,
and leaves private temporary artifacts for review. Its synthetic owner tests guest
viewing; authenticated API tests use signed synthetic JWTs. It does not test a live
Auth0 browser login, physical LiDAR capture or real-device accuracy.

```sh
cd services/api
TEST_DATABASE_URL="$TEST_DATABASE_URL" node --import tsx scripts/prepare-lidar-publishing-test.ts
```

The report prints scanRoot/captureRoot/revisionRoot and resource IDs. Start the API
with those paths as SCAN_STORAGE_DIR/CAPTURE_STORAGE_DIR/REVISION_STORAGE_DIR, the
same database and placeholder Auth0 settings for this isolated signed-out test.
Open report.sharePath or `/spaces/<spaceId>?path=<savedPathId>`. The fixture is a
transformed triangle with an existing one-edge saved route and a manual GLB.

Substitute the report's IDs before running:

```sh
cd apps/web
TEST_LIDAR_SHARE_URL=http://localhost:5173/s/<public-share-id> \
TEST_LIDAR_PRIVATE_SHARE_URL=http://localhost:5173/s/<private-share-id> \
TEST_LIDAR_MANUAL_SHARE_URL=http://localhost:5173/s/<manual-share-id> \
TEST_LIDAR_SPACE_URL='http://localhost:5173/spaces/<space-id>?path=<saved-path-id>' \
TEST_LIDAR_SCAN_ID=<approved-scan-id> \
pnpm exec playwright test tests/lidar-publishing.browser.spec.ts --workers=1
```

Verification: API typecheck/db:check; 26 API tests passed, one optional real-file test
skipped; ten frontend tests and frontend production build passed; make check passed
all legacy sharing modes. Chromium at 390×844 rendered the approved GLB share and
space saved route, loaded a manual GLB and denied private scenes/points and guest
frames. Both screenshots were visually inspected. API production build was run from
an isolated source copy with webpack to preserve an active development server.
Database test files run serially because worker fixtures share a global lock;
explicit competing-worker tests still run. No remote migration was applied.

## Landmark cues

Gemini's landmark directions ("Turn left at the purple mural.") belong to one approved scan revision.
Migration `0005_landmark_cues.sql` adds the `landmark_cues` table. It only creates a new table and two
enums, and it is not applied automatically: review it, then apply it the same way as 0002–0004.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/scan-revisions/:revisionId/cues` | The revision's owner (owner of both the capture and the space, as for approval) gets every cue in route order: `{cues: [{id, routeSegmentId, sequence, landmark, instruction, confidence, status, sourceFrameIds}]}`. Others get 404, and signed-out callers get 401. |
| `PATCH /api/cues/:id` | The owner sends `{instruction?, status?}`. `instruction` is 1–200 characters with whitespace collapsed. `status` is `draft`, `approved` or `rejected`. Returns `{cue}`. Approving needs text. Editing an `abstained` cue's text makes it a draft. Approved and rejected cues record who decided and when. |
| `GET /api/shares/:shareId/cues` | Anyone who may open the share gets its approved cues in route order. Guests get `sourceFrameIds: []`, because frames stay owner-only. Manual uploads return `[]`. |
| `POST /api/scan-revisions/:revisionId/cues/generate` | **The "Generate directions" button.** Owner only (same rule as review). Optional body `{regenerate?: boolean}`. For each of the owner's saved paths in the space, it finds the turns (left/right/stairs from the path points). It then picks photos near each turn from the scan's camera poses, asks Gemini for a direction, and saves it with `saveCueDrafts`. The same turn on several paths becomes one cue. Returns `{cues, summary: {turns, generated, abstained, skipped, noPhotos, failed, remaining}, turns: [{routeSegmentId, sequence, maneuver, outcome, code?}]}`. Errors: 409 `NO_SAVED_ROUTES` (save a route first), 409 `NO_PHOTOS` (scan has no camera photos), 503 `GEMINI_NOT_CONFIGURED`. |

`status` is `draft`, `approved`, `rejected` or `abstained` (Gemini found no clear landmark). `sequence` is
the turn's position along the route, so guests read cues in route order. The Gemini step stores its results
with `saveCueDrafts(db, revisionId, drafts)` in `src/lib/api/cues.ts`: one `{routeSegmentId, sequence,
landmark?, instruction, confidence?, abstained?, sourceFrameIds, model?, promptVersion?}` per turn. A rerun
replaces drafts and abstentions but never a turn the owner already approved or rejected. Gemini's original
text stays in `draft_instruction`. `GET /api/scans/mine` returns each scan's `revisionId` so the website's
review screen can find its cues.

### Generating directions (Krishna)

`src/lib/api/cue-generation.ts` holds the generate endpoint. It calls Krishna's internal Gemini service
(`services/gemini`, see its `INTEGRATION.md`) through `src/lib/gemini/client.ts`. Set
`GEMINI_SERVICE_URL` and `GEMINI_SERVICE_TOKEN` in `.env.local`, and run the service next to the API. The
token is a shared secret between the two servers; never expose it to the browser.

- **Turns:** `src/lib/gemini/turns.ts` (a copy of `services/gemini/clients/typescript/turns.ts`; keep them
  identical) turns each saved path into steps. Straight stretches and the arrival are skipped.
- **One cue per turn:** `routeSegmentId` is a stable key for "this turn, approached from this direction",
  such as `turn:0.0:0.0:-4.0:h0:left`. Paths that share a turn share one cue. The opposite direction is a
  different cue.
- **Photos:** frames come from `capture_frames` (camera poses). `scan.transform` places them in the space,
  because the processor keeps the GLB and the photos in the same capture frame. Each photo is read from
  private capture storage and checked against the manifest's size and SHA-256.
- **Gemini's best option** is saved. `confidence` comes from how clearly the landmark is visible: clear →
  high, partial → medium, uncertain → low. It is not a calibrated probability.
- **Time:** Gemini takes about 10–60 s per turn. One request handles at most 12 turns and reports
  `remaining`, so press the button again to continue. Each cue is saved as soon as it arrives.
- **Reruns:** turns that already have a cue are skipped unless `regenerate` is true. Approved and rejected
  cues are never sent again or replaced.
- **Failures:** if the service is busy (503/504) or the token is wrong, the run stops early and reports it.
  Earlier cues stay. A turn without good photos is reported as `no_photos`, and the owner can type a cue by
  hand.
- **Geometry columns:** once `landmark_cues` gains `maneuver`, `side`, `position` and `incomingHeading`,
  and `cueDraftInput` accepts them, the endpoint sends them automatically. No change is needed here.
