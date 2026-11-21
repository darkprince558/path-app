# Record and share a hallway on Wi-Fi

An organizer records on a phone, the Mac builds a textured GLB, and a guest opens the unlisted link in their phone’s browser. Both phones must be able to reach the Mac on the local network. The recorder runs without an account, public tunnel or cloud processing service.

## Start on the Mac

On a fresh checkout, prepare the Mac reconstruction tools and build the website once. FFmpeg, ffprobe, Node, pnpm and OpenSSL must be available. The pairing page displays QR codes when `qrencode` is installed. Its links also work without QR codes.

```sh
./hallway3d setup
./hallway3d setup-openmvs
(cd apps/web && pnpm install --frozen-lockfile && pnpm build)
./hallway3d record
```

Open [phone pairing on the Mac](http://127.0.0.1:8644/). Only the Mac can open this page. Leave the process running and keep the Mac awake through capture, processing and viewing. On a restarted Mac, use the same data directory to reopen previous shares. The default is `~/Library/Application Support/Path Recorder/`. Keep this directory on a local disk. Cloud-managed folders can evict depth maps while OpenMVS is still using them. Use `./hallway3d record --help` to change its directory or ports.

## Film and share

1. Join the same Wi-Fi on both phones. On each iPhone, use the **certificate QR** on the Mac. In Settings, install the downloaded profile, check its fingerprint against the Mac, and enable **Path Recorder Local CA** in **General → About → Certificate Trust Settings**. The local CA signing key is discarded after the Mac issues its server certificate. The Mac retains its HTTPS leaf key. [Apple’s certificate trust instructions](https://support.apple.com/en-us/102390)
2. On the organizer’s phone, scan the **recorder QR**. Tap **Start recording**. Allow camera and motion access, then check that the gyro and acceleration counters increase. A video-only take can proceed if motion access is unavailable. Film a continuous 15–25 second walk around one turn. Keep a doorway or textured feature visible as you move and keep the page in the foreground.
3. Tap **Stop recording**, review the clip, then **Process on Mac**. Short takes are kept locally in browser storage when available so an interrupted upload can be retried. The Mac accepts up to 90 seconds and 240 MiB per recording. The worker estimates camera poses, fuses depth, cleans the mesh and bakes the photos into the GLB.
4. When the scan is ready, tap **Open 3D scan** to review it. Use **Copy link** or the phone’s sharing control to send only the guest link to the second phone. Open it signed out and drag to orbit. No motion or camera permission is needed for viewing.

The recorder link grants organizer access and contains a private key after `#`. The guest URL is `/s/<shareId>` and grants access to that finished model. The original video, motion log, worker logs and other jobs have no guest endpoint. Pairing uses the Mac’s `.local` name so the link works after an address change when the service restarts. If a phone cannot resolve the name, expand the Wi-Fi address option on the Mac pairing page. Links created through that option use the current IP. Some guest Wi-Fi networks isolate clients; use a local network that permits phone-to-Mac connections.

## What motion does

The recorder saves elapsed milliseconds, angular velocity in degrees/s, linear acceleration and acceleration including gravity in m/s². Missing vectors are recorded as null. Browser event times approximate video timing. The worker checks sample coverage and duration agreement. Sustained, well-observed rotation can select a denser set of camera frames for a turn. If tracking coverage is weak, the worker can try a second sampling rate and retain the successful result with the greater fraction of supported camera poses. Motion permission, gaps, selection reason, counts and missing camera intervals are recorded per job in `motion-summary.json`. The video still determines the geometry, in arbitrary units.

## What was verified

A mobile-sized Chromium browser recorded a 12-second synthetic hallway through MediaRecorder and sent 482 simulated readings for each motion channel. After a Mac worker restart, the same saved upload produced a 9,533,924-byte GLB with one embedded texture and 218,558 triangles. The Mac registered all 96 sampled camera views. Reconstruction on the local disk took about 15 minutes for this take.

A fresh iPhone 16 Pro simulator running iOS 18.6 Safari opened the unlisted link over trusted local HTTPS and rotated the textured mesh by touch. A separate Safari recorder check used a generated camera feed and produced an H.264 MP4 that survived a page reload and passed the Mac's video intake. The physical two-phone check is to film a real hallway, confirm the sensor counters increase, and examine coverage around a turn from the guest phone.

## Repeat the checks

Run the checks below from the repository root. `make check` covers all three guest access modes, the venue fixture and the recorder upload, restart and sharing contract. The HTTP tests bind local sockets.

```sh
make check
python3 -B apps/capture/video3d/testdata/check_recorded_take.py
(cd apps/web && pnpm build && pnpm test)
```

The browser acceptance runner exercises an actual browser video recording of a synthetic hallway, synthetic motion, draft recovery, Mac processing, and a fresh guest browser. Use the running recorder’s LAN origin and pass the private key **file** directly. No private phone footage is required.

```sh
RECORDER_ORIGIN=https://YOUR-MAC-IP:8643 \
RECORDER_KEY_FILE="$HOME/Library/Application Support/Path Recorder/organizer.key" \
RECORDER_PYTHON="$PWD/captures-local/video3d-tools/.venv/bin/python" \
node apps/web/tests/recorder.browser.mjs
```
