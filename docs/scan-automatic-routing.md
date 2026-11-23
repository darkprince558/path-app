# Automatic routes in the scan viewer

Human owner: Sam. Frontend review: Arielle. Capture validation: Anish/Krishna.
Writable components: `apps/web/` and documentation. Acceptance: an authorized approved
GLB opens in the existing viewer, two floor picks produce a doorway route at the
approved elevation, and switching back preserves a saved manual route.

## Browser upload to route

1. Upload a GLB at `/maps/new`, then select **Plan a route** beside the sharing controls.
2. The shared viewer automatically builds the walkable floor. Double-click or
   double-tap a floor point for the start and another for the destination. The
   highlighted line follows the floor through connected openings; expand
   **Step-by-step directions** for relative turns and distances. Clear or replace
   either selection with the existing controls. Orbit and zoom still work.
3. A single GLB uses glTF's metres/+Y convention without needing a separately
   approved capture or graph. Unverified scale is labeled and distances use `≈`.
   This preview does not mark database calibration as verified. Explicit relative
   coordinates or a different up axis remain blocked until calibrated by the owner.
4. Missing floors, insufficient clearance and disconnected regions show an error;
   no straight line is fabricated through walls. Authorized asset downloads still
   enforce public, unlisted and private access before the viewer can build routes.

## Approved capture / multi-scan workflow

1. Run the Next.js API and Vite following [navigation integration](navigation-integration.md).
   Upload, process, review and approve a capture using the existing
   [LiDAR publishing workflow](lidar-publishing.md). The approved revision becomes
   a ready GLB scan. No new capture fields, processor behavior or database rows are needed.
2. Validated metric iPhone/iPad CPU captures now inherit calibration automatically on approval, with automatic alignment for a sole scan in an empty metric space. See [calibration and owner repair](scan-calibration.md). For imports or additional scans, confirm the scan's saved scan-to-space transform, orientation and measured scale
   using Owner tools in `/spaces/:spaceId`. Both the space and scan must declare
   calibrated metres/+Y up; the scan must have `metadata.alignmentVerified: true`.
   These are the existing [coordinate declarations](scan-data-contract.md), not
   inferred from the file extension. Unverified/relative multi-scan spaces remain viewable;
   their Automatic route control explains why generation is unavailable.
3. Open `/spaces/:spaceId` and check **Automatic route**, or open a `/s/:shareId`
   link where automatic routing starts enabled.
   Wait for “Walkable floor ready.” Recast generates navigation from all accessible
   displayed GLB triangles, including walls, door frames and obstacles.
4. Double-click (double-tap on touch) a walkable floor point for the start, then a
   destination. The amber line follows the Detour corridor through available doors;
   its distance appears in metres. **Set start**, **Set destination** and **Clear route**
   change the selection. Orbit and zoom remain available. Picked XYZ comes from the
   actual model surface: floors need not be at zero, and endpoints on disconnected
   floors do not silently snap to another storey.
5. Check **Show NavMesh debug** to see the generated green walkable triangles. It
   does not intercept floor picks. A blocked/outside pick clears the old route and
   explains the problem. A closed doorway reports “No complete route.” A model with
   no floor keeps its 3D view and explains the missing walkability/clearance.
6. Uncheck **Automatic route** to return to the manual graph and saved-path controls.
   Their selection stays intact. Automatic paths are temporary, cannot be saved as
   manual paths, and make no API writes. Owner surface picks reach graph tools only
   in manual mode. Replacing models/transforms or changing the guest Avoid stairs
   setting rebuilds navigation and clears endpoints. Avoid stairs sets maximum step
   to zero; ramps remain subject to the 40° slope limit. This is geometric filtering,
   not certification of physical accessibility.
7. Open the link signed out in a second browser/device. Test Public, Unlisted and
   Private using the publishing runbook: authorized readers may generate routes;
   denied metadata/assets must still return 404 and produce no canvas. Revoking access
   is checked by the existing server on the next request; already downloaded bytes
   cannot be revoked. No storage URLs or access grants are created by routing.

## Reproducible synthetic checks

```sh
cd apps/web
pnpm test
pnpm typecheck
pnpm build
pnpm exec playwright install chromium # first use only
pnpm test:navmesh:browser
cd ../..
make check
```

The dedicated browser suite starts Vite on port 5186 and needs no backend or secrets.
`tests/helpers/room-glb.ts` generates a self-contained synthetic GLB in memory: a
12 × 10 m floor, wall, 2 m doorway, lintel and obstacle. A glTF hierarchy translation
and separate approved scan matrix place the floor at Y=7.5 m, X offset 11 m and Z
offset −5 m. This tests the actual GLTFLoader-to-Recast-to-viewer flow without
committing capture bytes. Unit tests verify doorway crossings, blocked doors and
wrong-floor rejection. Browser tests mock only authorized API responses, then exercise
real GLB parsing, Recast WASM, WebGL picking, route rendering controls, invalid picks,
no-floor errors, denied/relative shares, fresh uncalibrated upload-to-route flows
at desktop and phone widths, and saved manual route restoration.
The original `/navmesh-demo` tests still run. Screenshots land in ignored
`apps/web/test-results/`.

These are synthetic and software-rendered Chromium checks. Repeat steps 1–7 with a
measured approved phone scan and a physical second phone before claiming real-device
performance, continuous coverage or usable venue routing. API permission enforcement
is unchanged; mocked browser responses are UI evidence, while `make check` exercises
all three sharing modes on the fixture API.

## Geometry and lifetime

`SpaceViewer` parses each authorized GLB once with `parseGlb(bytes, scan.transform)`.
`ScanNavigation` extracts the loaded objects' world triangles with the original
Task 6 `trianglesFromObject`. The existing wrapper preserves glTF hierarchy and bakes
the approved matrix exactly once; camera framing never moves geometry. Multiple
visible scans are combined in that same space frame. The original bounded Recast
adapter supplies clearance filtering, full-XYZ endpoint validation, complete-path
checks and corridor straightening. It approximates the shortest route on the
voxelized NavMesh; it does not promise an exact continuous-surface geodesic.

Recast is lazy-loaded when routing is enabled. Generated query/mesh and debug geometry are disposed
on disable, replacement and unmount; cancelled builds dispose their result. Geometry budgets support up to 4 million vertices and 4 million triangles;
voxel budgets remain 2 million horizontal cells and 2048 route polygons. The horizontal
grid is 10 cm when the footprint fits, otherwise the finest of 15, 20, 25 or 30 cm that does
(the 129 × 281 m Hack Western DEMO builds in about 1.3 s at 15 cm). There is no
bounding-volume cap: Recast stores only occupied spans, so multi-storey scans build
(a 48 × 45 × 9.5 m two-storey capture builds in about 0.3 s). Generation still runs on the
main thread after WASM initialization. Large captures may exceed the budget or pause
the UI and need worker/tiled generation in a later change. Alignment verification
asserts the coordinate frame, not that every observed surface is traversable.
Disconnected wall tops can be walkable polygons; there are no inferred stair/elevator
connectors, cached navigation, owner-approved automatic-route publication or geometry
repair in this change.


## Real scan verification (2026-11-22)

Sam's four local `paths/` GLBs were parsed and routed with the same GLTFLoader,
triangle extraction and Recast code. Zero-area depth-fusion faces are skipped;
all nondegenerate walls and obstacles are retained. No capture bytes are committed.

| Local scan | Usable source triangles | NavMesh triangles | Longest sampled complete route |
| --- | ---: | ---: | ---: |
| Walk 2126 Hallway | 449,405 | 1,144 | 9.05 m |
| Walk 2134 Hallway | 1,372,530 | 3,731 | 20.75 m |
| Walk 2228 Hallway | 569,992 | 1,443 | 27.65 m |
| Sammy worker replay mobile scene | 155,653 | 4,092 | 30.31 m |

The sampled routes connect NavMesh triangle centres; they are geometry checks,
not observed walking directions or physical clearance measurements. The 2134 raw
GLB exceeds the existing 32 MiB upload cap; upload size changes are tracked separately
in PR #53. The mobile output fits the cap. Browser tests use a synthetic doorway GLB
and mocked upload/share responses, while the API suite separately verifies real GLB
uploads and authorized downloads against a disposable PostgreSQL database.
