# Capture and processing

The isolated [LiDAR contract integration](../../docs/lidar-contract-compatibility.md)
adapts the native exporter and [CPU processor](processor/README.md) to the existing
backend contract. Its shared synthetic fixture is `fixtures/lidar-native-capture/`.

Krishna and Anish own the phone capture, export and alignment pipeline. Start by scanning a short corridor with an identifiable turn. Try exporting colored PLY from a LiDAR phone and give Arielle and Sam the resulting format, file size, encoding, axis convention and a known distance. Keep local captures in the ignored `captures-local/` directory at the repository root.

Save several camera frames while recording and label which turn or landmark they show. These are the inputs for Gemini’s directions experiment. For the venue milestone, verify scan-to-event alignment before exporting the routing graph in meters.

[First phone trial and format alternatives](../../docs/scan-formats.md) · [Shared venue example](../../fixtures/README.md)

## Map a hallway

Connect an unlocked development-enabled iPhone to the Mac, then run `./scripts/install-ios-scanner.sh` from the repository root. Tap **Start walk** once and keep Path Capture in the foreground. The phone holds one gravity-aligned AR session and saves numbered sections while you walk. **Finish walk** closes the last section. If iOS interrupts capture, the review shows the reason. Previously completed sections survive an app restart. A new walk has its own coordinate frame.

The overhead map projects measured surface hits into 25 cm tiles. Mint means a depth or visual feature landed there. Dark areas have no displayed samples. The white line tracks the camera and breaks when tracking is unreliable. The yellow arrow shows the last tracked viewing direction. Tap **Show whole walk** at a junction, then **Follow me** to see nearby detail. Use the camera overlay to inspect wall height and other details a top-down projection hides.

**Walk review** includes the full map, a lightweight 3D point overview, and individual textured sections. Under processing pressure a section can retain its points, photos and depth for Mac reconstruction while an earlier textured surface finishes. The original single-scan review and per-section LiDAR upload remain available for compatible saved takes.

### Fuse the walk on a Mac

In **Walk review**, tap **Prepare whole walk for Mac**, then **Share whole walk** and AirDrop the ZIP. Unzip it on the Mac. Use the directory that contains `walk.json`. An older complete scan archive containing `scan.json` also works. The complete archive contains private camera images and footage.

From the repository root, with Python 3.12:

```sh
python3.12 -m venv apps/capture/walk/.venv
apps/capture/walk/.venv/bin/pip install -r apps/capture/walk/requirements.txt
apps/capture/walk/.venv/bin/python apps/capture/walk/reconstruct.py "/path/to/extracted/Walk-ID" "/path/to/hallway.glb" --view
```

The Mac integrates tracked keyframes and confidence-filtered metric LiDAR depth in the recorded ARKit frame using Open3D’s scalable TSDF. The output is a coloured 3D surface. The default voxel width is 4 cm. Missing depth, tracking gaps and accumulated pose drift can leave holes or misaligned surfaces. Separately started walks need an explicit alignment before their geometry can be combined. [Open3D RGB-D integration](https://open3d.org/html/tutorial/pipelines/rgbd_integration.html)

Krishna and Anish own the physical trial. Walk a measured hallway with two turns past the former 85-second limit. Revisit the starting doorway and check end offset, measured width, both turns, and any uncovered stretches. Keep the capture on the device or Mac.

### Try a walk in the simulator

Add `-PathCaptureReplay hallway` to the Xcode scheme's launch arguments to open the scan screen with a synthetic three-minute hallway at four times walking speed. Tap **Finish walk** to review the map you just saw. Remove the argument to return to the saved-scan library or record on a compatible phone.

During a walk, the map button hides or restores the mini map. Tap the mini map to expand it, then use **Collapse map** to return. The layers button toggles the camera surface overlay. Your map layout and overlay setting carry over to the next walk. Swipe up on the recording strip, or tap the section count, to see the recording details.
