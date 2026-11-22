# !404 scan and navigation contract

Integration owner: Sam. Capture owners: Krishna and Anish. Frontend owner: Arielle.
The first acceptance case is one **real phone-video reconstruction**, uploaded through
Sam's scan API, rendered with textures in Arielle's viewer, with a manually verified
route, then opened by a second user through the public space link. Synthetic fixtures
verify software behavior only; they do not complete this acceptance case.

## Primary handoff: textured GLB

Deliver one self-contained glTF 2.0 binary (`.glb`, `model/gltf-binary`) with triangle
meshes, UVs, materials and embedded PNG/JPEG textures. Embed all buffers and images;
do not reference sibling files, local paths, remote URLs or signed URLs. The initial
viewer needs standard glTF materials and `KHR_materials_unlit`, which the PR #19
exporter uses for photographed appearance. Preserve the loaded materials and scene
hierarchy. Compression requiring extra Draco, Meshopt or KTX2 decoders is outside this
demo contract. The existing API upload limit is **400 MiB**.

Use PR #19's `mesh/hallway.glb` from a completed reconstruction run. Its
`mesh/report.json` provides export sizes, triangle counts and provenance; retain the
full report privately with the source capture. Do not upload the entire report as
public metadata: it can contain source filenames and capture poses. PLY remains an
optional point-cloud alternative and does not block this integration.

On the capture branch, the supported entry points are:

```sh
./hallway3d setup
./hallway3d setup-openmvs
./hallway3d /path/to/phone.MOV --surface mesh
# Or mesh a completed OpenMVS run:
./hallway3d mesh /path/to/run
```

The Mac workflow uses Python 3.12+, FFmpeg/ffprobe, pycolmap, NumPy, OpenCV,
plyfile and SciPy; OpenMVS 2.4.0 supplies densification, reconstruction and texturing.
Node.js/pnpm run the comparison viewer. These are capture-side dependencies, not
additional services required by the upload API or guest viewer.

## Coordinate frames and matrix order

The target **space** is right-handed with **+Y up**. Choose and record a stable
space-local origin, for example a floor point at the entrance, with +X along a known
wall. Every graph node, destination and saved-path waypoint belongs to this frame.
It is not a GPS position. Independent scans need separate scan-to-space transforms;
they cannot be aligned merely by assigning them the same `spaceId`.

A monocular reconstruction initially has **relative units**. A GLB extension alone
does not prove physical scale. PR #19's export defines +X image-right, +Y image-up and
−Z forward from the first registered camera. A tilted starting camera therefore
produces a tilted room. Correct the orientation manually before calling it a verified
Y-up room. Do not claim metre accuracy, accessibility dimensions or measured route
lengths from uncalibrated geometry.

`scan.transform` is a finite, invertible affine 4×4 **column-major** array, using
column vectors. It maps the exported GLB's scene coordinates into the space:

```text
p_space = M_scan_to_space × p_glb_scene
p_glb_scene = M_gltf_node_world × p_mesh_vertex
M_scan_to_space = T × Rz × Ry × Rx × S
```

`S` is a positive uniform scale. Rotation controls are degrees about the named axes;
convert to radians when constructing matrices. Operations apply right to left:
scale, rotate X, rotate Y, rotate Z, then translate. This explicit order avoids
ambiguity with an Euler library's convention. Apply `scan.transform` to a parent of
the loaded glTF scene, preserving every glTF node's own transform. Do not overwrite
node matrices or recenter each scan independently. A camera target can be based on
the combined transformed bounds without moving the models or graph.

Array storage is `[m00,m10,m20,m30,m01,m11,...,m33]`; translation is at indices
12–14 and the affine final row is `[0,0,0,1]`. For example, this transform scales by
2 and translates by `(10,0,-3)`, mapping exported point `(1,2,3)` to `(12,4,3)`:

```json
[2,0,0,0, 0,2,0,0, 0,0,2,0, 10,0,-3,1]
```

**Do not apply the reconstruction report's `world_to_view` again.** PR #19 already
bakes it into `mesh/hallway.glb` vertex positions. That report uses a nested 4×4
matrix for reconstruction provenance, not the API's flat array. Start with an
identity `scan.transform` and add only the chosen space alignment/calibration.

## Metadata and upload example

Store the space frame declaration in `space.boundary.coordinateSystem`; preserve
other boundary fields. Store the scan's output frame declaration in
`scan.metadata.coordinateSystem`. Both use:

```json
{"units":"relative","upAxis":"Y","calibrated":false}
```

`units` is `relative` or `metres`. The declaration describes coordinates **after**
`scan.transform`, not the GLB's original units. A calibrated metric space uses
`{"units":"metres","upAxis":"Y","calibrated":true}`. These fields are an
integration convention within existing JSON fields, not a globally enforced database
schema. Producers must keep them consistent; the integration UI checks mismatches.
Missing declarations mean unknown scale, never an implicit metric guarantee. `upAxis`
names the intended space axis; `orientationVerified` separately records whether a
human checked the reconstruction against the room.

The integration viewer also requires `scan.metadata.alignmentVerified: true` before
displaying navigation. The owner sets this after checking floor orientation, origin,
and scale (measured for a metric space). Until then the mesh can be inspected and
aligned, but route overlays stay hidden. This is a human assertion, not a computed
accuracy score. In a metric space, the scan's `calibrated` flag remains false until
that confirmation. For relative scans it remains false even after alignment.

Example initial upload from an authenticated browser on the API origin:

```js
const form = new FormData();
form.set('file', selectedGlbFile);
form.set('name', 'Phone room reconstruction');
form.set('visibility', 'public'); // requires a public parent space
form.set('transform', JSON.stringify([
  1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1
]));
form.set('metadata', JSON.stringify({
  alignmentVerified: false,
  coordinateSystem: { units: 'relative', upAxis: 'Y', calibrated: false },
  reconstruction: {
    source: 'monocular-video', exportedUnits: 'relative',
    orientationVerified: false
  }
}));
const response = await fetch(`/api/spaces/${spaceId}/scans`, {
  method: 'POST', body: form
});
if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
const { scan } = await response.json();
// Use scan.downloadPath; do not construct an object-storage path.
```

Fetch accessible scans with `GET /api/spaces/:id/scans`; each ready scan supplies
`downloadPath` for its protected bytes. Persist later alignment using
`PATCH /api/scans/:id` with `transform` and the merged metadata. Use returned scan
IDs and `spaceId`, never filenames, to identify scene objects.

## Manual alignment and calibration

1. Pick the space origin and floor plane. Rotate the model until its observed floor
   lies in the XZ plane; check vertical door frames. Translate the chosen origin to
   the intended space coordinate. Record `orientationVerified: true` only after
   checking it against the actual room or capture evidence.
2. If no physical measurement is available, retain relative units. Choose graph
   nodes directly in the transformed scene and label distances as relative units.
3. To calibrate, identify two stable points in the exported GLB scene and measure
   their actual separation. If their exported distance is `d` and the physical
   measurement is `L` metres, set uniform scale `s = L / d`. Use the original
   exported coordinates for `d`, not points already scaled by a previous transform.
   Rotate and translate afterward. Store optional `metadata.calibration` such as
   `{"sourceDistance":2.5,"measuredDistanceMetres":1,"scale":0.4}`. These numbers
   are illustrative, not measurements of the team's room. The saved matrix is
   authoritative; the viewer must not apply `calibration.scale` a second time.
4. Establish the space units before authoring the graph. A change from relative units
   to metres after graph creation requires coordinated rescaling of every node and
   edge distance, every scan alignment and any stored boundary coordinates. The
   demo UI prevents changing the space frame after nodes exist; recreate the demo
   space or perform an explicit coordinated migration instead.
5. For additional scans, match known landmarks to the existing space using manual
   scale, rotation and translation. Check at least three separated landmarks, with
   a floor/vertical reference, so one coincident point cannot hide a bad alignment.

In the owner UI, picking a point records the scan ID with a new graph node. Alignment
is locked once that scan has navigation nodes, while new scans can still be aligned.
Legacy graph nodes without scan IDs conservatively lock all scan alignments; prepare
the new scan's final matrix before upload in that case. Manual matrix edits clear
the previous calibration evidence and require alignment confirmation again. Graph
nodes remain in space coordinates when a new scan is added.

A single measured baseline establishes scale; it does not establish the accuracy of
the whole mesh. Record the baseline and check another independent distance before
making an accuracy claim. Holes, warped walls and drift can remain after calibration.

## Navigation and authorization

Graph coordinates are already space-local. Never apply an individual scan transform
to graph nodes or route overlays. Overlay nodes and edges in a sibling group to the
transformed scans. Every node must have the selected `spaceId`. Destinations reference
nodes in that space. A route uses only explicit graph edges, respecting their direction
and stored positive cost; geometry alone does not establish walkability. Manual
nodes should be placed on verified traversable floor, including turns, with each edge
checked against the room. Rendering a line is not proof that it avoids a wall.

The demo can select existing start and destination nodes. A free position must be
explicitly connected to a verified start node; nearest-node snapping alone does not
prove that the joining segment is walkable. A* must use an admissible heuristic for
the stored edge costs (zero is safe when costs do not bound geometric distance).
Disconnected endpoints produce a no-route state. Saved paths must retain their
ordered waypoint/node IDs and pass the same adjacency checks before display.

The backend checks the parent space and each scan independently on metadata and file
reads. Making a space, path or event public must not reveal a private scan. Public
space sharing requires publishing the intended scan as well. Private reads require
the existing owner/viewer authorization; event access to a private space alone is not
a scan grant. The core API has public/private visibility; the older mock's unlisted
share IDs are a separate interface and must not be treated as core API access grants.

## Evidence and outstanding acceptance work

Inspected capture source at PR #19 commit `02577111751b630cdc807e78490db8d49351f1a6`:

- [Capture commands and frame convention](https://github.com/darkprince558/path-app/blob/02577111751b630cdc807e78490db8d49351f1a6/apps/capture/README.md).
- [GLB exporter: embedded atlas, unlit material and baked transform](https://github.com/darkprince558/path-app/blob/02577111751b630cdc807e78490db8d49351f1a6/apps/capture/video3d/mesh_geometry.py).
- [Recorded phone trial](https://github.com/darkprince558/path-app/blob/02577111751b630cdc807e78490db8d49351f1a6/knowledge/mac-video-trial.md): 15.7-second iPhone RGB recording, 181,931 textured triangles, 11.65 MB GLB and one 4096×4096 atlas. Gaps remain; physical accuracy was not measured.

PR #19's format is suitable for this handoff based on exporter inspection and the
recorded trial. The real artifact was not found in this integration workspace;
Krishna/Anish must supply the privately retained `mesh/hallway.glb` before its bytes,
textures, alignment and second-browser behavior can be verified here. Do not replace
that final test with `fixtures/venue/sample-triangle.glb`.

[PR #12](https://github.com/darkprince558/path-app/pull/12) is an alternative LiDAR
point-cloud recorder with a documented device build, not the primary camera path.
[PR #22's field notes](https://github.com/darkprince558/path-app/blob/f7660b88a10e165f11b96023e1189ec42bfb5b4c/knowledge/mac-field-mapping.md)
record LIMAP line reconstruction but no measured doorway-width improvement; it is not
a prerequisite for this demo. [PR #15](https://github.com/darkprince558/path-app/pull/15)
provides the existing PLY viewer architecture to extend with GLB loading.

Record final acceptance with the real file's byte size/hash, capture identification
without private source paths, chosen transform, calibration evidence or relative-unit
label, start/destination IDs, a saved-path ID, browser/device, and observed texture and
route alignment. Open the public link in a fresh signed-out browser session, then
verify that a private scan's metadata and raw download remain inaccessible. Keep the
capture itself and credentials out of Git and PRs.
