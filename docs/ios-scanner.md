# Scan a hallway with Path Capture

Path Capture records offline on an ARKit-capable iPhone or iPad running iOS or iPadOS 17 or newer. A LiDAR device builds a metric mesh as you walk. The app projects photos onto faces whose depth agrees with the camera, and keeps measured faces with vertex colors where a photo cannot be fitted. It reports wall and floor triangle counts on devices that support ARKit classification. An ARKit phone without LiDAR records colored visual landmarks, camera poses, video and motion. Either device can send its video to the Mac for a second reconstruction.

## Install on the phone

1. Connect the unlocked device to the Mac by USB and tap **Trust** if prompted. Open Xcode once and sign in under **Settings → Accounts**. Enable **Settings → Privacy & Security → Developer Mode** on the device, restart, and confirm. [Apple device setup](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
2. From a local checkout on the Mac, run the installer below. With several devices connected, supply the device name as its argument. The installer asks Xcode to register the selected device with the active development team, signs the app, installs it and launches it. A development IPA installs only on devices included in its provisioning profile.
3. To install from Xcode instead, open `apps/capture/PathCapture.xcodeproj`, choose **PathCapture → Signing & Capabilities**, select your team and, if necessary, use a bundle identifier your team owns. Select the phone as the destination and click **Run**. Use a checkout outside iCloud Drive if Xcode stalls opening the project.

```sh
./scripts/install-ios-scanner.sh
```

## Record, review and share

1. Tap **Start scan** and allow camera and motion access. Keep the app in the foreground. The overlay shows tracking status and the measured surface or visual features. Start with the floor and a recognizable doorway in view, then carry a landmark across the turn. On a Pro phone with LiDAR, sweep the wall-floor junction from two positions.
2. Tap **Finish scan**. Open the saved take and drag the model to orbit it. The details show camera poses, motion readings and recovered geometry. The app automatically finishes at 85 seconds or when the live mesh reaches about 220,000 triangles. It keeps up to 300,000 colored points. An interrupted scan can retain a partial take.
3. To publish on the same Wi-Fi, start the Mac recorder and trust its local HTTPS certificate on both phones. In the app, tap **Connect to Mac**, then scan the **recorder** QR code on the Mac pairing page or paste the organizer link. Recording and local review work before this step. [Mac setup and certificate instructions](phone-recorder.md)
4. Tap **Publish native scan**, then **Share native scan link**. The second phone opens that link in a browser. Publishing sends the GLB. The original video, keyframe images, camera poses and motion logs stay on the recording phone.
5. For a comparison from the same take, tap **Reconstruct camera video on Mac**. This sends the video and its motion sidecar through the Mac’s camera-based pipeline and returns a separate guest link. That pipeline estimates its own camera poses and scale. The complete archive retains the ARKit calibration and depth for subsequent analysis.

## Export files

Use **Prepare complete scan archive**, then **Share complete scan archive** to save or AirDrop a ZIP. Individual exports are also in the take details, and the scan folders are visible in Files under **On My iPhone → Path Capture → Scans**.

| File | Contents |
| --- | --- |
| `scene.glb`, `points.ply` | Portable textured mesh or point model, plus binary little-endian XYZ/RGB points. Positions use ARKit world coordinates in metres, right-handed with +Y up and camera forward along local −Z. Mesh vertices carry the classification in the first byte of the custom `_AR_CLASSIFICATION` attribute. Embedded textures mask regions outside projected faces. |
| `camera.mp4`, `camera-poses.json` | H.264 camera video and per-delivered-frame tracking state, image size, 4×4 camera-to-world transform and 3×3 camera intrinsics. Matrices are column-major. Pose times are seconds from the first AR frame. Intrinsics use the original camera-buffer resolution. |
| `motion.json` | Timestamped Core Motion device acceleration with and without gravity in m/s², and rotation rates in degrees/s. The app requests 50 Hz. Use sample timestamps for actual timing. Milliseconds share the first AR frame’s time origin. |
| `keyframes.json`, `photo-*.jpg` | On mesh-capable devices, selected unrotated RGB frames are indexed by pose, timestamp and camera intrinsics. Scale the original intrinsics to JPEG or depth dimensions when working in pixels. |
| `depth-*.f32`, `confidence-*.u8` | When ARKit supplies scene depth, tightly packed row-major float32 little-endian depth in metres. The optional confidence map uses one byte per pixel. Dimensions and filenames are in the corresponding keyframe. |
| `scan.json` | Take identity, mode, duration, counts, partial status and publication state. The scan coordinate frame still needs alignment to any venue map. |

## Export a LiDAR upload bundle

In Scan Review, enter the capture UUID issued by Sam’s backend under **LiDAR upload bundle**. Tap **Prepare LiDAR bundle**, then **Share LiDAR bundle**. The ZIP contains a `capture/` directory with the mesh, colored cloud, selected JPEGs, camera poses, preview and SHA-256 manifest. Recording can happen offline before the server allocates the UUID. Keep original camera frames in private storage.

For Krishna’s landmark trial, unzip the bundle and point `python -m path_gemini.trial list` at the extracted `capture/` directory. Each record in `frames.json` has a stable capture-local `frameId` (for example, `frame-0007`), `imagePath` relative to that directory, `mimeType`, `timestampSeconds` from the first AR frame, `trackingState`, and the JPEG’s pixel `width` and `height`. Select two or three approved frames for one verified turn.

The `intrinsics` values (`fx`, `fy`, `cx`, `cy`) are in pixels of the unrotated exported JPEG. `cameraToWorld` maps from the camera to the ARKit scan frame in metres, in column-major order. `manifest.json` records the entrance pose for alignment. Sam’s worker can continue reading `path`, `timestampMs` and `cameraPose` from the same records.

To send the simulator export directly through the CPU processor, pass the installed worker executable as a second argument to `scripts/check-ios-scanner.sh`.

## Verify

```sh
xcrun simctl list devices booted
./scripts/check-ios-scanner.sh <booted-simulator-UDID>
make check
(cd apps/web && pnpm build && pnpm test)
```

The Swift fixture has a two-metre wall, two photographically supported triangles, a depth-rejected floor texture and a separate sparse point model. The check validates both exported GLBs through the Mac intake and exercises opening and rotating the saved wall in the simulator. These checks can run without camera or LiDAR hardware.

For the physical acceptance trial, use a hallway with a known doorway width. Check that camera poses and motion readings increase, inspect the turn in the on-device and second-phone views, compare the mesh to the measured width and note any holes. Keep real scans and organizer links outside Git. Anish and Krishna own the capture trial.
