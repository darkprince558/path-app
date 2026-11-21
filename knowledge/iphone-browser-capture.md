# Recording a scan from the Path App website

**20 November 2026 · Anish and Krishna · [Capture issue #4](https://github.com/darkprince558/path-app/issues/4)**

Path App should provide its own recording flow. iPhone Safari can record RGB video from the rear camera with `getUserMedia` and `MediaRecorder` over HTTPS. WebKit does not support WebXR immersive AR on iOS, and Safari does not expose the iPhone's LiDAR depth frames to a webpage. Native iOS code can access per-frame depth and confidence through ARKit on devices that support the scene-depth capability. [WebKit camera capture](https://webkit.org/blog/11353/mediarecorder-api/) · [WebKit iOS WebXR status](https://bugs.webkit.org/show_bug.cgi?id=309550#c2) · [Apple's ARKit depth sample](https://developer.apple.com/documentation/arkit/displaying-a-point-cloud-using-scene-depth)

## Browser-only capture

1. The organizer opens a capture page on an iPhone and grants camera access. Path App previews the rear camera, records a short walk around the turn, and uploads the clip for processing. Request video only.
2. The worker extracts overlapping frames and uses COLMAP to estimate camera poses and reconstruct geometry. Start with a sparse reconstruction to check whether the hallway tracks. Test dense reconstruction on a supported GPU worker if the sparse result registers the turn. Blank walls and repeated doors can make matching unreliable. Record a measured distance so the organizer can set and verify metric scale. [COLMAP reconstruction tutorial](https://colmap.github.io/tutorial.html) · [COLMAP worker requirements](https://colmap.github.io/install.html)
3. The worker produces colored PLY or self-contained textured GLB. The organizer previews the result and chooses visibility. Keep the source video private and use the existing asset and share paths for the finished model. The current [mock upload API](../services/api/README.md) accepts finished PLY or GLB, so source video needs a separate ingest and processing path.

## First-party LiDAR capture

If the demo needs actual LiDAR, build a small Path App iOS capture screen around ARKit. Collect depth, confidence, camera intrinsics and poses, and a few RGB frames for landmarks. Export colored PLY in meters and send it to Path App's upload flow. The website handles the venue, review, and shared view. A Path App App Clip is a later way to launch native capture from Safari. It requires a corresponding iOS app and App Store setup. [ARKit depth sample](https://developer.apple.com/documentation/arkit/displaying-a-point-cloud-using-scene-depth) · [App Clip setup](https://developer.apple.com/documentation/appclip/configuring-the-launch-experience-of-your-app-clip)

## Acceptance test

Have the organizer record one recognizable turn with a measured reference and a readable sign. Record phone, browser or iOS capture build, recording and processing times, asset size, and measured scale error. Use a signed-out second phone to open the share link and identify the turn. The platform capabilities above come from Apple, WebKit and COLMAP documentation. Browser recording, reconstruction quality, and second-phone sharing still need the [device trial](https://github.com/darkprince558/path-app/issues/5).
