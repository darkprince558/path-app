# Capture and processing

Krishna and Anish own the phone capture, export and alignment pipeline. Start by scanning a short corridor with an identifiable turn. Try exporting colored PLY from a LiDAR phone and give Arielle and Sam the resulting format, file size, encoding, axis convention and a known distance. Keep local captures in the ignored `captures-local/` directory at the repository root.

Save several camera frames while recording and label which turn or landmark they show. These are the inputs for Gemini’s directions experiment. For the venue milestone, verify scan-to-event alignment before exporting the routing graph in meters.

[First phone trial and format alternatives](../../docs/scan-formats.md) · [Shared venue example](../../fixtures/README.md)

## Try a regular phone video on a Mac

Anish and Krishna can use an ordinary MOV or MP4 from the phone's Camera app. The Mac estimates camera poses, triangulates colored feature tracks, and adds surface samples where two views and nearby tracks agree. The output is a binary RGB point cloud (`scene.ply`) that opens in Path's guest viewer. A single video gives relative shape. Physical dimensions require a measured reference.

1. Film a short continuous pass, about 15–25 seconds at 1080p, 30 fps, using the rear 1× camera. Start level, include the floor, and move slowly past a doorway, poster or turn. Keep that detail in several shots from different positions, including a small sideways step. Use the same lens and zoom throughout. Measure the width of the doorway if you want a physical reference later.
2. AirDrop the original movie to the Mac. From the repository root, run the commands below. You can type `./hallway3d ` and drag the movie from Finder into Terminal to fill in the path.
3. In the browser, drag to orbit and scroll to zoom. Compare the doorway, the direction of the turn and any missing wall sections with the original video. Press Ctrl-C in Terminal to stop the preview. Each reconstruction gets a new folder under `captures-local/runs/`.

```sh
./hallway3d setup                   # once on a new Mac
./hallway3d "$HOME/Downloads/hallway.MOV"
```

Setup uses Python 3.12+, FFmpeg 9 with ffprobe, Node.js 22.12+ and pnpm. Tested on Apple Silicon with Python 3.12. Reconstruction runs on CPU. The Python packages are isolated in `captures-local/video3d-tools/`. Setup builds the repository's web workspace when available, or uses the pinned [guest viewer from PR #15](https://github.com/darkprince558/path-app/pull/15). After setup the video, sampled images, reconstruction and preview stay on the Mac. The preview URL is loopback-only.

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

The demo renders a known hallway into a video and processes it through the same entry point as a phone movie. The check compares recovered camera centers, point-to-surface distances and the door color with the synthetic scene after one scale alignment. Choose a new output folder for each repeat. Use `--sparse` to inspect only triangulated features, or `--fps 5 --max-frames 180` to try closer frame spacing on a fast segment. Defaults sample up to three frames per second and distribute at most 120 across the clip.
