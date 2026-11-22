# LiDAR contract compatibility integration

Human owners: Anish (native exporter/CPU processor) and Sam (backend contract/tests).
Integration branch `integration/lidar-contract-compatibility`, based on
`feature/lidar-pipeline` at `4ab8337`. Sources imported without merging PRs:
#33 `2e995f4` (native app/export and its supporting tests/scripts) and
#32 `61aae46` (standalone CPU processor). Their remote PRs are unchanged.

## One contract

The existing `services/api/src/lib/capture/contract.ts` and the `transform`
validator in `services/api/src/lib/api/scans.ts` are authoritative and unchanged.
`npm run contract:export --prefix services/api` generates the processor's
`contract.mjs` directly from these Zod declarations, retaining all refinements.
The processor has its own Zod dependency, so `npm ci --prefix apps/capture/processor`
is sufficient for standalone CPU use: no Next.js, Auth0, database or TypeScript
runtime is required. `contract:check` fails when generated validators drift.

Native export now emits numeric version 1, `capturedAt`, device `{model,osVersion}`,
coordinates `{units:"metres",upAxis:"Y",handedness:"right",matrixLayout:"column-major",poseConvention:"camera-to-capture"}`,
and file entries `{path,byteSize,sha256}`. The frame envelope is
`{version:1,captureId,frames}`; entries contain `id`, `imagePath`, `timestampSeconds`,
`width`, `height`, `cameraPose` and optional `{fx,fy,cx,cy}` intrinsics.

JPEG dimensions come from the saved JPEG. Intrinsics are scaled from the original
camera dimensions to those pixels; older takes without calibration omit intrinsics.
New takes record the OS version, and older takes honestly emit `unknown (legacy scan)`.
Pose matrices, frame numbering and the first normally tracked entrance pose are
preserved; seconds are no longer rounded through integer milliseconds. Hashes are
computed only after writing the final frame index. Export checks the 100 MiB file,
2 MiB frame-index, 256 MiB bundle and 1,000-frame limits.

CPU intake uses those generated strict validators, permits the full backend frame-ID
alphabet, checks manifest/index capture-ID agreement and image references, and retains
filesystem inventory, symlink rejection, checksum, JPEG decoding, GLB and native PLY
validation. It additionally checks declared frame dimensions against JPEG dimensions.
Thus a valid JSON contract alone does not guarantee processable geometry/media.

`report.sourceManifestSha256` is the canonical backend manifest identity.
`sourceManifestFileSha256` separately records the exact input manifest bytes.
Reports preserve normalized frame fields, poses and coordinate declarations.

## IDs and upload

The saved `ScanRecord.id` is the device UUID in both JSON files and the ZIP name.
Export no longer asks for a server UUID. `POST /api/captures` accepts
`{spaceId,manifest}` and returns a separate database `capture.id`, with the device
UUID echoed as `capture.deviceCaptureId`. Use the database UUID in upload/finalize
URLs. Pass `capture.deviceCaptureId` to the processor's `--expected-capture-id`.
Do not rewrite the bundle after registration: retries require the same immutable
manifest, frame IDs and bytes under the same owner/device UUID.

Registration stores `manifest.json`; upload the declared payload files individually,
not the ZIP or manifest itself. The ZIP's `capture/` directory is a local transfer
container. Existing ownership checks, private storage and checksum rules still apply.

## Shared fixture and checks

`fixtures/lidar-native-capture/` adapts Anish's synthetic Swift-generated wall assets
to this contract. The original backend fixture remains unchanged. Geometry and
photographs are synthetic. Physical scanning, doorway coverage and NavMesh behavior
are outside this task.

```sh
npm ci --prefix apps/capture/processor
npm ci --prefix services/api
npm test --prefix apps/capture/processor
npm run contract:check --prefix services/api
npm run typecheck --prefix services/api

# Schema imports initialize the existing Auth0 SDK; these are offline test settings.
cd services/api
export AUTH0_AUDIENCE=https://api.not404.test
export AUTH0_DOMAIN=example.auth0.com
export AUTH0_CLIENT_ID=test-client
export AUTH0_CLIENT_SECRET=test-only
export AUTH0_SECRET=0000000000000000000000000000000000000000000000000000000000000000
node --import tsx --test src/lib/api/lidar-contract-compatibility.test.ts
node --import tsx scripts/check-capture-bundle.ts ../../fixtures/lidar-native-capture
# Use placeholders and an unreachable DB for a build without database access:
DATABASE_URL=postgresql://none:none@127.0.0.1:1/none APP_BASE_URL=http://localhost:3000 npm run build -- --webpack
cd ../..
make check

# Standalone processor; destination must not already exist:
work=$(mktemp -d)
./process_lidar_capture --input fixtures/lidar-native-capture --output "$work/revision" \
  --expected-capture-id 6d8c1359-2480-4493-89b8-39be20cc6fc9

# macOS + Xcode: actual Swift exporter -> backend validator -> CPU processor:
bash scripts/check-lidar-contract-export.sh
# Optional complete native simulator/UI check:
bash scripts/check-ios-scanner.sh <booted-simulator-UDID> "$PWD/process_lidar_capture"
```

The dedicated GitHub workflow runs Linux compatibility checks and the Swift export
chain plus unsigned simulator build on macOS. Local Linux checks cannot substitute
for executing that macOS job. Export tests include saved JPEG dimensions/calibration,
two stable poses/IDs, and a legacy-take case without stored calibration/OS details.
Linux tests cover actual CPU output, authoritative validator parity, wrong device
UUID versus database UUID, canonical manifest provenance, invalid legacy fields,
unsafe paths, invalid poses/bounds, foreign frame references, checksums, dimensions
and symlinks.

## Integration status

Local verification on Linux: API regression suite 30 passed / 1 optional real-scan
test skipped; focused compatibility checks, CPU processor suite, contract drift
check, API typecheck, production webpack build, shell/JavaScript syntax checks and
`make check` passed. The build retains the upstream Auth0 dynamic-dependency warning.
The checked-in fixture validates as two frames with canonical manifest SHA-256
`414a135aad4c9e3e84a5b32d485c1eaf11540743c3dca2a6dc7fc490bb10f4e8`.
Swift/Xcode are unavailable on this Linux host, so the new macOS exporter tests,
simulator build and optional UI test were not executed here. Adding their CI job
does not claim that it has run.

These changes prepare #32/#33 for contract integration; they do not switch the
asynchronous backend worker away from its mock. The real CLI still requires a fresh
output directory; the existing worker pre-creates one. Its adapter, process
cancellation, processor version selection and failure mapping remain a separate
integration task. Native physical-device verification and the macOS build/export
gate remain required before declaring the iPhone handoff verified.

No NavMesh, Gemini, web frontend, database schema, backend validation, API permissions
or remote migrations are changed. Native UI changes are limited to using the saved
take UUID for bundle export. Local capture test databases may be used for existing
API regression tests; never point those tests at Tiger Data.
