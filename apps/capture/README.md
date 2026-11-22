# Capture and processing

The isolated [LiDAR contract integration](../../docs/lidar-contract-compatibility.md)
adapts the native exporter and [CPU processor](processor/README.md) to the existing
backend contract. Its shared synthetic fixture is `fixtures/lidar-native-capture/`.

Krishna and Anish own the phone capture, export and alignment pipeline. Start by scanning a short corridor with an identifiable turn. Try exporting colored PLY from a LiDAR phone and give Arielle and Sam the resulting format, file size, encoding, axis convention and a known distance. Keep local captures in the ignored `captures-local/` directory at the repository root.

Save several camera frames while recording and label which turn or landmark they show. These are the inputs for Gemini’s directions experiment. For the venue milestone, verify scan-to-event alignment before exporting the routing graph in meters.

[First phone trial and format alternatives](../../docs/scan-formats.md) · [Shared venue example](../../fixtures/README.md)

## Map a hallway

Connect an unlocked development-enabled iPhone to the Mac, then run `./scripts/install-ios-scanner.sh` from the repository root. Tap **Start walk** once and keep Path Capture in the foreground. The phone holds one gravity-aligned AR session and saves numbered sections while you walk. **Finish walk** closes the last section. If iOS interrupts capture, the review shows the reason. Previously completed sections survive an app restart. A new walk has its own coordinate frame.

On a LiDAR phone, **Scan your left side** or **Scan your right side** appears above **Finish walk** when the app repeatedly sees upright surfaces on one side and little coverage on the other. The arrow follows your direction of travel. Sweep the phone toward that side. Seeing the surface or looking through a sufficiently deep opening can clear the cue. The arrow also clears when tracking drops.

The overhead map projects measured surface hits into 25 cm tiles. Mint means a depth or visual feature landed there. Dark areas have no displayed samples. The white line tracks the camera and breaks when tracking is unreliable. The yellow arrow shows the last tracked viewing direction. Tap **Show whole walk** at a junction, then **Follow me** to see nearby detail. Use the camera overlay to inspect wall height and other details a top-down projection hides.

**Walk review** includes the full map, a lightweight 3D point overview, and individual textured sections. Under processing pressure a section can retain its points, photos and depth for Mac reconstruction while an earlier textured surface finishes. The original single-scan review and per-section LiDAR upload remain available for compatible saved takes.

### Other sensors

ARKit keeps doing the position tracking. Three other sensors each have one narrow job.

- **Barometer: floor changes.** During a walk the app logs relative air-pressure height and notices when you settle on a different floor (a change of more than about 2 m that then holds for about five seconds). It says so on screen and lists it in **Walk review** under **Sensors**, as "by stairs or ramp" when ARKit saw the climb too, "by elevator" when ARKit's own height stayed put, or with no label when tracking was unreliable. The first walk may ask for Motion & Fitness access; without it no readings are saved. Each section also gets `altitude.json`. It can tell that you changed floors and roughly how far. It cannot tell which floor you are on: pressure differs by metres between phones and drifts with the weather.
- **Motion and exposure: sharper photos.** When a photo for texturing is due, the recorder now waits up to about half a second for a steady frame instead of taking the first one, using the phone's turn rate, sideways speed and the camera's exposure time to estimate smear. If no steady frame comes it takes a softer one after about a second, so in dim light photos can be spaced a little further apart than before. `keyframes.json` records the estimate as `blurPixels`. While you move too fast for sharp photos the screen says so.
- **GPS and compass: where the walk starts (off by default).** Switch on **Tag where this walk starts** before starting. The app asks for location access, listens for about 12 seconds, and saves the most certain position and one compass reading with the first section, shown in **Walk review**. Start outdoors: indoors the position can be off by tens of metres, and the compass by 15° or more anywhere. The tag labels the entrance. It never positions or rotates the indoor map. It is stored in `scan.json`, so it travels with a shared walk archive.

The phone's thermal state is checked every five seconds. When iOS reports it as serious, a warning shows for a few seconds every half minute, and the review notes that the walk ran hot.

The thresholds (2 m floor change, 3 pixels of smear) are starting values, chosen from published figures and not yet tuned on a device. [Sources and reasoning](../../knowledge/scanner-sensors.md)

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

In the expanded map or Walk review, drag to pan, pinch to zoom, twist with two fingers to rotate, or double-tap a spot to zoom in. Tap **Recenter** to follow your position again, **Whole walk** to fit the route, or **Map orientation** to switch between heading-up and the initial walking direction. The camera remains live in the upper-left corner while the map is expanded.

In the simulator, **Try a simulated walk** on the library screen starts the same replay without editing the scheme.
