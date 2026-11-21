# Capture and processing

Krishna and Anish own the phone capture, export and alignment pipeline. Path Capture is our native iPhone and iPad recorder for the demo. It uses ARKit's LiDAR scene depth and RGB camera to produce a colored point cloud.

## Run on the demo phone

1. Open `apps/capture/PathCapture.xcodeproj` in Xcode on a Mac. Connect a LiDAR-equipped iPhone or iPad running iOS/iPadOS 17 or later. Select the `PathCapture` target, choose your team in **Signing & Capabilities**, and select the physical device as the run destination. If Xcode asks, use a bundle identifier unique to your team and enable Developer Mode on the device. [Apple's on-device setup](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)
2. Run the app. Tap **Start scan**, grant camera access, and wait for points to appear. Start at the entrance with the phone pointed into the route, then walk slowly around one well-lit turn. Include a recognizable landmark and two reference points a tape-measured distance apart.
3. Tap **Stop scan**, then **Share PLY** and **Save to Files**. Select that PLY in the website's organizer upload. For local integration from a Mac, the [mock API's upload example](../../services/api/README.md) works with the exported bytes.
4. Open the unlisted link signed out on a second phone. Record the capture device, point count, file size, observed versus tape-measured distance, and time to an interactive view. Ask the guest to identify the turn.

## Asset handoff

The export contains binary little-endian PLY vertices with 32-bit XYZ and 8-bit RGB. The cap of 300,000 points keeps the asset below 4.6 MB. Positions are in meters in the scan's right-handed ARKit frame, with +Y up and initial forward approximately −Z. The origin is the starting camera pose. Align the scan to the [venue event frame](../../fixtures/README.md) before overlaying waypoints.

The recorder samples medium- and high-confidence depths from 0.25 to 4 m and keeps one point per 3.5 cm voxel. The voxel spacing controls density. Use the measured corridor to check accuracy. The demo recorder uses a file handoff. Save separate landmark photos for the [Gemini trial](../../docs/gemini-demo.md) and keep private captures in the ignored `captures-local/` directory.

## Verify

Run the unsigned device build and the repository checks from the root.

```sh
xcodebuild -project apps/capture/PathCapture.xcodeproj -scheme PathCapture \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
make check
```

The simulator can launch the app and show the unsupported-device message. The device build checks compilation. Measure depth, color quality, orientation, and the full phone-to-website handoff on a physical LiDAR device.
