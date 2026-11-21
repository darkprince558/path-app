# Capture and processing

Krishna and Anish own the phone capture, export and alignment pipeline. Start by scanning a short corridor with an identifiable turn. Try exporting colored PLY from a LiDAR phone and give Arielle and Sam the resulting format, file size, encoding, axis convention and a known distance. Keep local captures in the ignored `captures-local/` directory at the repository root.

Save several camera frames while recording and label which turn or landmark they show. These are the inputs for Gemini’s directions experiment. For the venue milestone, verify scan-to-event alignment before exporting the routing graph in meters.

[First phone trial and format alternatives](../../docs/scan-formats.md) · [Shared venue example](../../fixtures/README.md)

## Try a regular phone video on a Mac

Anish and Krishna can use an ordinary MOV or MP4 from the phone's Camera app. The Mac estimates camera poses, triangulates colored feature tracks, and adds surface samples where two views and nearby tracks agree. The output is a binary RGB point cloud (`scene.ply`) that opens in Path's guest viewer. A single video gives relative shape. Physical dimensions require a measured reference.

1. Film a short continuous pass, about 15–25 seconds at 1080p, 30 fps, using the rear 1× camera. Start level, include the floor, and keep a doorway or poster visible as you round the corner. Seeing the same detail from different positions helps estimate depth. Use the same lens and zoom throughout. Measure the width of the doorway if you want a physical reference later.
2. AirDrop the original movie to the Mac. From the repository root, run the commands below. You can type `./hallway3d ` and drag the movie from Finder into Terminal to fill in the path.
3. In the browser, drag to orbit and scroll to zoom. Compare the doorway, the direction of the turn and any missing wall sections with the original video. Press Ctrl-C in Terminal to stop the preview. Each reconstruction gets a new folder under `captures-local/runs/`.

```sh
./hallway3d setup                   # once on a new Mac
./hallway3d "$HOME/Downloads/hallway.MOV"
```

Setup uses Python 3.12+, FFmpeg 9 with ffprobe, Node.js 22.12+ and pnpm. Tested on Apple Silicon with Python 3.12. Reconstruction runs on CPU. The Python packages are isolated in `captures-local/video3d-tools/`. Setup builds the repository's web workspace when available, or uses the pinned [guest viewer from PR #15](https://github.com/darkprince558/path-app/pull/15). After setup the video, sampled images, reconstruction and preview stay on the Mac. The preview URL is loopback-only.

### Compare walls and floor with OpenMVS

```sh
./hallway3d setup-openmvs
./hallway3d "$HOME/Downloads/hallway.MOV" --surface compare
```

The optional installer downloads the pinned OpenMVS 2.4.0 Apple Silicon binaries into the project's local tools folder and checks their hashes. For an existing installation, use `--openmvs-bin /path/to/bin`. [Upstream release](https://github.com/cdcseacave/openMVS/releases/tag/v2.4.0)

The command estimates camera positions once. The stereo backend uses supported matches between image pairs. OpenMVS uses the same positions and undistorted copies of those frames to estimate and fuse depth maps across multiple views. Both exports use the same coordinate transform and a maximum of 600,000 points for the viewer. `scene.ply` contains the stereo result and `openmvs.ply` contains the OpenMVS result. OpenMVS also keeps its full-density `openmvs/dense.ply` in COLMAP coordinates. Use `--surface openmvs` for a single OpenMVS export as `scene.ply`.

In the comparison viewer, select a capture time to inspect the scan at eye level. Press **A** for Stereo or **B** for OpenMVS. The camera and point size stay fixed as you switch. Orbit, zoom, and toggle again to compare a doorway, a section of floor or gaps along a wall. Reopen an existing comparison with `./hallway3d preview "/path/to/run/scene.ply" --compare "/path/to/run/openmvs.ply"`.

To see the phone frame alongside both point clouds throughout the walk, run the following from the repository root using the comparison run's folder. It writes a movie, three still views and projected pixel coverage at the same point count and dot size. [Measured phone trial](../../knowledge/mac-video-trial.md#walking-speed-phone-recording)

```sh
run="/path/to/run"
captures-local/video3d-tools/.venv/bin/python apps/capture/video3d/testdata/compare_surfaces.py \
  "$run" "$run/scene.ply" "$run/openmvs.ply" "$run/surface-evidence" --video
```

### Compare a textured mesh with its points

For an existing OpenMVS run, keep its directory intact, including the dense scene, point cloud, calibrated images and original report. Run these commands from the repository root.

```sh
./hallway3d setup-openmvs
./hallway3d mesh "/path/to/run"
```

This opens two synchronized views of the same hallway. The left pane shows cleaned RGB points. The right pane shows triangles textured with the original camera images. Select **Solid** to inspect bumps and holes under neutral lighting, or **Textured** to see the photo colors. Select a capture time or drag either pane to move both cameras together. For a new video, `./hallway3d "/path/to/hallway.MOV" --surface mesh` also handles tracking and densification.

The mesher uses the camera observations saved in the OpenMVS scene. It removes unsupported triangles and small detached pieces before it projects the images onto the surface. The standalone `mesh/hallway.glb` embeds the textures and uses the same coordinate frame as `mesh/points.ply`. Their scale is relative. Gaps can remain on smooth surfaces or where the camera saw too little detail.

The new `mesh/report.json` records cleanup counts and output sizes. The original reconstruction and both of its point clouds stay available for comparison. To run another mesh trial, supply a new `--output` directory. To reopen the saved comparison:

```sh
./hallway3d preview "/path/to/run/mesh/points.ply" --mesh "/path/to/run/mesh/hallway.glb"
```

### How the phone is tracked

The default samples up to eight keyframes per second, with at most 160 spread across the clip. It first matches SIFT features and builds an incremental model. If some frames drop out or have weak 3D support, it also tries global mapping, including a candidate enriched with features tracked forward and backward through the decoded video. FFmpeg's decoder indices associate those observations with the correct keyframe even when the frame rate varies. For long clips the tracker increases the stride beyond its 3,600-source-frame budget and keeps all selected keyframes.

The pipeline chooses a connected model using triangulated observations, checks for parallax, and tests global trajectories against a usable overlapping incremental section when available. `--mapping global` requests the global candidates even after a successful first pass. `--mapping incremental` reproduces the original mapping strategy. The report records the chosen method, attempts, number of registered frames and any weakly supported poses. A model can cover a whole turn while still leaving holes in its wall.

### Read a run

| File | What to look for |
| --- | --- |
| `scene.ply` | Colored XYZ samples. Open again with `./hallway3d preview "/path/to/scene.ply"`. The first registered camera defines right, up and forward. A tilted start produces a tilted scene. |
| `report.json` | Registered versus sampled frames, approximate time ranges that failed, sparse or stereo output, point count, bytes and runtime. Reprojection error is measured in image pixels. Holes in the floor or blank walls can persist even when every camera registers. |
| `frames/`, `sfm/models/` | Inspect the actual images at a gap or compare the saved camera poses and triangulated tracks. Separate components have independent coordinate frames. The export uses the strongest connected section. |

If a segment is missing, revisit that timestamp and film the same features from a second position. If the hallway shape is present but walls look patchy, try another pass closer to textured surfaces and include door frames or signs. A stationary pan can yield too little depth for an export.

### Reproduce the local check

```sh
./hallway3d demo --no-preview --output captures-local/hall-check
captures-local/video3d-tools/.venv/bin/python apps/capture/video3d/testdata/check_hallway.py captures-local/hall-check
./hallway3d preview captures-local/hall-check/scene.ply
```

The demo renders a known hallway into a video and processes it through the same entry point as a phone movie. The check compares recovered camera centers, point-to-surface distances and the door color with the synthetic scene after one scale alignment. Choose a new output folder for each repeat. Use `--sparse` to inspect only triangulated features, or `--fps 3 --max-frames 120` for the earlier, faster sampling preset. To exercise variable frame rates and portrait rotation, run `captures-local/video3d-tools/.venv/bin/python apps/capture/video3d/testdata/check_tracking.py`.
