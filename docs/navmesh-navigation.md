# Task 6: automatic NavMesh navigation

Human owners: Arielle (Three.js viewer) and Sam (later revision integration), with Anish validating real geometry and metric clearance. The verifiable Task 6 outcome is a synthetic room route automatically generated from triangles, with no hand-placed graph nodes. Changes are confined to `apps/web/` and documentation. Tiger Data, APIs, authentication, capture processing, Gemini, manual navigation and saved routes are unchanged.

## Run the demo

Requires Node 22+ and pnpm; no API, account, database or capture worker is required.

```sh
cd /tmp/path-navmesh-task6/apps/web
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1 --port 5186 --strictPort
```

Open `http://127.0.0.1:5186/navmesh-demo`. In a normal checkout, use that checkout's `apps/web` directory instead. This work is isolated on branch `feature/navmesh-navigation`, based on the committed Task 5 implementation.

1. The room is 12 × 10 m, with a wall at X=0, a doorway at Z=1..3 m, 2.4 m headroom, and a box obstacle on the left. Default start is (-4, 0, -2), destination (4, 0, -2). The amber route is approximately 10.71 m and crosses the doorway, avoiding the wall and box.
2. Choose **Set point**, then double-click any floor point. Start selection advances to destination selection. The X/Z inputs allow keyboard selection of arbitrary points on this single floor (Y=0); the underlying adapter accepts full XYZ points. Invalid points show a message and clear the route.
3. Toggle **Show walkable overlay**. Green surfaces come from the generated NavMesh, including clearance around obstacles, rather than a separately drawn approximation.
4. Check **Close doorway**: the two sides disconnect and show “No complete route.” Uncheck it to recover.
5. Expand **Agent clearance settings**. Set radius to 1.1 m, then **Rebuild NavMesh**: the doorway is too narrow. Restore 0.3 m. Setting height to 2.7 m also blocks it. Reset points restores the original endpoints; rebuilding preserves selected endpoints and revalidates them.
6. Enter destination X=100: the endpoint is rejected instead of snapping through barriers or to a distant region.

## Implementation and limits

The [`recast-navigation-js` project](https://github.com/isaac-mason/recast-navigation-js) is installed through its `recast-navigation` 0.44.0 package. [`navmesh.ts`](../apps/web/src/lib/navmesh.ts) initializes the WASM module once, validates triangle data and resource budgets, calls `generateSoloNavMesh`, and exposes `route`, debug triangles and idempotent `dispose`. The demo route is lazy-loaded, so existing manual navigation does not initialize Recast.

Input coordinates are right-handed, metres, +Y up, counter-clockwise triangles. Recast cell size is 0.10 m horizontally and 0.05 m vertically. Radius and height are rounded up to voxel counts; maximum step is rounded down. Defaults are radius 0.30 m, height 1.80 m, maximum slope 40°, maximum step 0.20 m. Slope classification, low ceiling filtering, ledge/climb filtering and radius erosion use the triangle geometry. These are conservative rasterized approximations, not a physical accessibility certification.

Endpoint queries require a polygon directly under the point and at most 0.15 m vertical difference, allowing voxelization error without horizontal snapping. Detour can return a successful partial corridor for disconnected regions; the adapter checks partial, out-of-nodes and buffer statuses and verifies that the last polygon and final route point reach the requested destination. No partial route is drawn. Query arrays, meshes, debug buffers and fixture resources are disposed on rebuild/unmount. Concurrent first builds share initialization so React StrictMode cannot create mismatched WASM instances.

Empty geometry, nonfinite coordinates, invalid indices, incomplete or degenerate triangles, invalid settings, excessive rasterization bounds, and no walkable output produce errors. The current small-room budget is 600k vertices, 200k triangles, two million horizontal cells, and 2048 corridor polygons/route points. Generation is synchronous after initialization and bounded for this fixture. Larger venues need a cancellable Web Worker and tiled generation; this task does not claim large-scan performance. Static mesh extraction rejects skinning, instancing and morph targets until baked. Triangle coverage (including all mesh geometry) determines potential walkability: disconnected wall/box tops can appear green, but cannot be reached from the floor. Unknown or missing geometry must not be treated as surveyed empty space in a real deployment.

## Integrated scan routing

The existing space and shared-GLB viewers now implement this integration. Follow
[Automatic routes in the scan viewer](scan-automatic-routing.md) for the current
workflow, tests and limits. The notes below record the Task 6 adapter requirements
that the integration preserves.

## Real LiDAR revision integration point

The adapter is reusable with existing approved GLBs, and automatic routing is now opt-in in the existing viewers as well as `/navmesh-demo`. It does not publish a graph or overwrite existing manual routes. Follow these steps when adding real-revision review:

1. Resolve the approved `scan.sourceRevisionId` and authorized GLB through the current scan file/share scene endpoints. Keep the Task 5 server ownership, visibility and approval checks; never fetch storage paths supplied by the browser. A visible approved scene does not imply owner-approved navigation.
2. Require verified alignment and metre/+Y-up coordinate declarations from the existing scan/space contract. Parse with `parseGlb(bytes, scan.transform)`. Pass its wrapper `model.object` to `trianglesFromObject` while it is detached from any presentation-only scene transform. Extraction updates world matrices and bakes the glTF node hierarchy plus scan-to-space transform exactly once, with winding corrected for reflected transforms. Do not recenter the geometry, apply the scan transform again, or relabel relative units as metres. The fixture tests include translation, hierarchy and reflection.

   ```ts
   const model = await parseGlb(bytes, scan.transform);
   try {
     const navigation = await buildNavMesh(trianglesFromObject(model.object), agent);
     // Query using space-frame XYZ surface picks; render navigation.debug and returned points.
     // Retain navigation while the revision is active; dispose it on replacement/unmount.
   } finally {
     model.dispose(); // Extraction copied triangles; it retains no GLB resource references.
   }
   ```

3. For several aligned scans, gather their transformed triangle arrays into one common space frame (adjusting indices), then generate a combined mesh. Do not join independent meshes by nearest-node distance across walls. Exclude hidden/unverified geometry deliberately during review; do not infer that every exported mesh is surveyed navigable floor. Validate observed coverage, doors, clearance and floor identity with Anish on a measured capture. Stairs/elevators need explicit verified connectors in a later phase.
4. Bind any future cached/exported NavMesh to immutable revision ID(s), transforms, generator version and all agent/rasterization parameters. Different dimensions require regeneration. Changing geometry/alignment must invalidate the matching automatic route. Store draft routing provenance separately and require owner review before publication; this task adds no persistence or migrations.
5. Reuse `SpaceViewer.onPick` space-frame positions and its route overlay contract in a future opt-in mode. Picks on walls, obstacle tops or another storey must be validated, not projected onto the selected floor automatically. Preserve `navigation.ts` and the existing graph/path APIs as the authoritative manual/saved-route mode. Automatic paths are ephemeral XYZ polylines here: they do not insert nodes, overwrite manual corrections, save paths, or change existing route IDs. Manual override reconciliation/publication remains a later task.

## Verification

```sh
cd apps/web
pnpm test
pnpm typecheck
pnpm build
pnpm exec playwright install chromium  # first use only
pnpm test:navmesh:browser
cd ../..
make check
```

The dedicated Playwright config starts and stops Vite on 127.0.0.1:5186 (the port must be free), requiring no environment secrets. Unit tests run actual Recast WASM for doorway routing, circular obstacle clearance, arbitrary endpoints, disconnected regions, radius/headroom, threshold step clearance, a 30° ramp under two slope limits, malformed geometry, concurrent initialization and transformed geometry. Existing GLB/manual graph/saved-route tests still run. Browser tests exercise ray picking, coordinate entry, overlay toggles, doorway disconnection and radius changes at 1280×1000 and 390×844; screenshots are under `apps/web/test-results/` (ignored by Git).

Verified locally: 18 unit tests, both Chromium viewport tests, typecheck, production build, and root fixture/sharing smoke checks pass. Vite still reports large chunks (including lazy Recast WASM compatibility code); Three.js emits an upstream Clock deprecation warning. No remote database changes were made. This is synthetic geometry and software-rendered Chromium evidence, not physical iPhone/LiDAR, real venue clearance, or device performance evidence.
