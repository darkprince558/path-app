# PathFinder LiDAR pipeline: phone scan to shared 3D map

## Goal and MVP boundary

In 10–12 hours, capture **one short, mostly level venue section** with a LiDAR iPhone, export a **solid triangle mesh**, upload it to PathFinder, and open an unlisted 3D view on a second phone. A guest uses the hosted website; LiDAR capture happens in a phone app because iPhone Safari does not expose ARKit scene reconstruction to an ordinary website.

The point cloud is an intermediate product of scanning. The deliverable for the viewer is a mesh with triangle faces. Do not build custom point-cloud fusion, automatic multi-scan merging, live indoor positioning, or automatic safe-route inference for this MVP.

## Technology and repository choices

| Stage | MVP choice | Why |
| --- | --- | --- |
| Phone capture and reconstruction | Free [RTAB-Map iOS app](https://apps.apple.com/ca/app/rtab-map-3d-lidar-scanner/id1564774365), backed by [introlab/rtabmap](https://github.com/introlab/rtabmap) | Existing LiDAR capture, map correction, and optimized mesh export; no new iPhone app or Xcode build for the primary path. |
| Exchange format | PLY **mesh** with nonzero triangle faces; vertex colors if available | The existing API accepts PLY, and Three.js can load its geometry. PLY can also contain only points, so inspect the export. |
| Hosted viewer | [Three.js `PLYLoader`](https://threejs.org/docs/pages/PLYLoader.html), rendered as a shaded `Mesh` | Solid surfaces, touch orbit and zoom in the guest browser. |
| Upload and sharing | Sam's API: `POST /api/scans?format=ply&visibility=unlisted`; guest URL `/s/<shareId>` | Matches the [current API contract](../services/api/README.md). The local mock accepts PLY or GLB and limits files to 32 MiB. |
| Fallback capture | [ARKitRoomScanner](https://github.com/koliangyu99/ARKitRoomScanner) and its GLB processing flow | Use only if a usable meshed PLY cannot be produced by hour 2. This path requires a Mac, Xcode, and a physical LiDAR device. |

Pipeline: **LiDAR iPhone → RTAB-Map point-cloud reconstruction and optimized mesh → PLY export → validate and align → upload → hosted Three.js mesh viewer → unlisted link**.

## Capture, validation, and handoff

1. Scan a quiet corridor or room with a recognizable turn. Walk slowly, keep nearby surfaces in view from overlapping angles, and return through recognizable features so RTAB-Map can correct drift. Save the original scan locally.
2. Export the optimized **mesh**, not a raw point cloud. Check the PLY header for `element face` with a count greater than zero. Confirm that the file opens, contains a useful floor/wall shape, and has vertex colors if the chosen export supports them.
3. Record phone model, scan preset, file size, export time, one measured real-world distance, and the entrance-to-turn direction. Align the mesh to the event frame used by the [venue fixture](../fixtures/README.md): metres, Y-up, entrance at the origin, +X right, −Z forward. Apply the same verified transform to the mesh and its future waypoints.
4. Give Sam the approved PLY and its format/size/orientation notes. Give Arielle that same file and transform. Sam uploads and publishes only after geometry validation; Arielle renders the model and manually places verified walkable waypoints and destinations in the shared coordinate frame.
5. Supply two or three permitted still photos of the turn, labeled with the scan and nearby waypoint, for the Gemini landmark trial. Gemini suggestions remain drafts until an organizer approves and pins them.

The existing [synthetic PLY fixture](../fixtures/venue/scene.ply) has points but no faces. Keep it for point-cloud/upload checks, and add a small meshed fixture when implementing the solid-surface viewer. The hosted API should validate parseability and a nonzero face count rather than trusting the PLY header alone.

## Risks and responses

| Issue | MVP response |
| --- | --- |
| A person or moved object leaves ghost geometry | Scan when clear, revisit after movement stops, inspect the export, and crop or redo the short scan if a ghost remains near the route. Do not claim automatic dynamic-object removal. |
| The same wall is scanned from multiple angles | Use overlapping views and RTAB-Map's optimized map. Inspect for doubled surfaces. If tracking or loop closure fails, recapture; voxel reduction controls density but does not identify unique objects. |
| Reflective surfaces, glass, thin objects, or hidden corners produce holes | Leave missing areas visibly incomplete. Place waypoints only along a route an organizer physically checked. |
| PLY contains only points or has poor solid geometry | Verify faces during the first two hours. Switch to the ARKitRoomScanner GLB path if the real export cannot provide a usable solid mesh. |
| Colors do not make a sign recognizable | Pair the mesh with an approved still photo and landmark cue. Try a textured GLB only after the core shared model works. |
| Export exceeds 32 MiB or loads slowly on a guest phone | Crop to the relevant section or lower export density. Measure bytes and time to interactive orbit before increasing any upload limit. |
| Model, waypoints, or route are rotated or scaled differently | Verify one measured distance and entrance-to-turn direction before publication. Use one event transform for every asset and waypoint. |
| Venue connection fails during judging | Keep a previously uploaded, known-good scan and its share link ready. Clearly state if a step is replayed. |

## Schedule and acceptance

| Time | Checkpoint |
| --- | --- |
| 0–2 h | RTAB-Map runs on the physical phone; a real PLY export has triangle faces and fits the upload limit. Trigger the GLB fallback if it does not. |
| 2–5 h | Scan the demo section; verify geometry, color, scale, alignment, and absence of obvious ghosts or doubled walls. |
| 5–8 h | Upload the real mesh; open and orbit it through the hosted unlisted link on a signed-out second phone. |
| 8–12 h | Improve export density/framing, capture final venue data, hand off Gemini photos, and rehearse the demo. |

**Done when:** a signed-out guest opens the actual hosted link on a second phone, sees solid surfaces at sensible scale, orbits smoothly, and recognizes the intended turn. Mesh and manually placed waypoints align. Malformed, oversized, and points-only files fail clearly rather than publishing as a finished solid model.

**Owners:** Krishna and Anish handle capture, export, validation, and alignment. Sam handles persistent upload and sharing. Arielle handles the mobile web viewer and organizer-verified waypoint graph. A displayed route is a suggestion, not an accessibility or collision-free guarantee.

## References

- [RTAB-Map iOS app and supported exports](https://apps.apple.com/ca/app/rtab-map-3d-lidar-scanner/id1564774365)
- [RTAB-Map optimized mesh export notes](https://github.com/introlab/rtabmap/issues/729)
- [Three.js PLYLoader](https://threejs.org/docs/pages/PLYLoader.html)
- [WebKit response on iOS WebXR support](https://bugs.webkit.org/show_bug.cgi?id=309550)
