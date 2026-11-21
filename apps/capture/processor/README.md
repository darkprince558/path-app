# LiDAR capture handoff

Anish owns the iPhone exporter and CPU processor. Sam can exercise his worker against the checked-in [synthetic bundle](../../../fixtures/lidar-native-capture/manifest.json). It contains a two-metre square wall at Z = −2 m, a colored point cloud and two generated JPEG views. The original Swift-generated assets use an adapted version 1 manifest and frame index; see the [compatibility runbook](../../../docs/lidar-contract-compatibility.md) for provenance and the macOS exporter check. No Apple tooling is required on the worker.

## Run the fixture

From the repository root with Node.js 22.12+ and npm, run:

```sh
npm ci --prefix apps/capture/processor
workdir=$(mktemp -d)
./process_lidar_capture --input fixtures/lidar-native-capture --output "$workdir/revision" \
  --expected-capture-id 6d8c1359-2480-4493-89b8-39be20cc6fc9
cat "$workdir/revision/report.json"
npm test --prefix apps/capture/processor
```

The command uses CPU and local files. The fixture produces 200 triangles in `master.glb`, 100 in the mobile `scene.glb`, and 121 RGB points in `scene.ply`. Both models retain the two-metre span and embedded wall texture. The revision also contains a point-rendered `preview.jpg` and `report.json`. The report gives asset hashes and sizes, capture ID, source manifest hash, coordinate system, entrance pose, tracking warnings, and each original frame ID, relative path, timestamp and pose.

## Export on iPhone

Record a LiDAR surface scan in Path Capture and stop to save it. Recording works offline. Open the saved scan under **LiDAR upload bundle**, tap **Prepare LiDAR bundle**, then **Share LiDAR bundle** to save or transfer the ZIP. The ZIP contains a `capture/` directory. The scanner’s existing complete archive also includes private video, motion and depth buffers. Use the dedicated LiDAR bundle for this handoff.

A saved scan needs triangles, colored points and at least one tracked JPEG. Older compatible saved takes can be packaged with the same action. The manifest records an unknown device model when the original take predates device identification.

## Bundle version 1

| Path | Meaning |
| --- | --- |
| `manifest.json` | Stable device/take UUID, UTC capture time, device, coordinates, entrance pose, warnings, and one relative path, byte count and SHA-256 per payload file. |
| `source.glb` | Embedded triangle mesh. The scanner applies each ARKit anchor transform once when exporting its vertices to scan-world coordinates. |
| `points.ply` | Binary little-endian XYZ float32 and RGB uint8 in the same world frame. |
| `frames.json`, `frames/*.jpg` | Selected unrotated JPEGs. Each record has a capture-local ID derived from the recorded photo number, relative path, seconds from the first AR frame, and a camera-to-world transform. |
| `preview.jpg` | First selected camera frame for private intake. The worker renders a separate revision preview from the points. |

Positions are metres in ARKit's right-handed, +Y-up world. Camera forward is −Z in camera space. Matrices are column-major with translation at indices 12–14. The entrance pose is the **first normally tracked camera pose**. A venue organizer can identify which physical doorway that corresponds to. The worker preserves the coordinate frame and uses the source mesh's materials, textures and classification attributes. Its master welds matching vertices. Its mobile copy targets half the triangles per surface group with 32 or more triangles, locks group borders and limits geometric error to 0.001 of mesh extent. Small or constrained groups can retain their original count.

## Sam's worker

1. Register the device UUID and manifest for the authenticated owner. Materialize the finalized files into a worker-owned input directory. Finish all writes before starting the processor. Point `--input` at the directory containing `manifest.json`. Pass the manifest device UUID (not the database capture UUID) as `--expected-capture-id`.
2. Supply a fresh revision directory name under an existing local parent. Exit **0** means all five files are ready. Exit **2** means the input was missing, invalid or unprocessable. Exit **1** means an output, filesystem or runtime failure. Exit **64** means CLI usage was invalid. The backend adapter must store bounded, sanitized failure diagnostics. A complete revision appears with a single rename and an existing revision is preserved.
3. Store source frames privately. Keep the capture ID with each local frame ID when addressing it across captures. For example, `frame-0007` maps to `frames/frame-0007.jpg` at 1.25 s in this fixture. Sam assigns the immutable revision ID and binds that ID to the route and Gemini cue. The CLI creates local files. Publication, approval, ownership checks, and storage are handled by the backend.

The processor verifies file inventory, hashes, byte sizes, readable JPEGs, pose and frame references, embedded triangle GLB and native PLY. The intake accepts up to 1,000 selected frames (32 MiB/file, 2 MiB frame index) and 256 MiB per bundle. Run a physical LiDAR trial for scale, recognizable landmarks and actual mobile load time.

To exercise the complete UI-to-worker handoff on a Mac, run the following from the iOS bundle checkout with a booted simulator. Pass the absolute path to the installed worker checkout’s executable:

```sh
./scripts/check-ios-scanner.sh <booted-simulator-UDID> /path/to/worker/process_lidar_capture
```

The script generates the synthetic take through the Swift geometry exporter, opens it in Scan Review, prepares the ZIP, and processes its extracted contents.
