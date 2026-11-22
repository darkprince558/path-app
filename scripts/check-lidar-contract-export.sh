#!/usr/bin/env bash
# macOS: actual Swift writer -> backend Zod/checksums -> standalone CPU command.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
command -v xcrun >/dev/null || { echo 'This check requires macOS and Xcode.' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/lidar-contract-export.XXXXXX")
trap 'rm -rf "$work"' EXIT
src=apps/capture/PathCapture
xcrun swiftc -O "$src/WalkMap.swift" "$src/ScanSource.swift" "$src/ReplaySource.swift" "$src/PointCloud.swift" "$src/ScanGeometry.swift" "$src/ScanRecord.swift" "$src/CaptureBundle.swift" "$src/MacConnection.swift" apps/capture/native-tests/main.swift -o "$work/export"
"$work/export" "$work/fixture"
(cd services/api && AUTH0_AUDIENCE=https://api.not404.test node --import tsx scripts/check-capture-bundle.ts "$work/fixture/capture")
(cd services/api && AUTH0_AUDIENCE=https://api.not404.test node --import tsx scripts/check-capture-bundle.ts "$work/fixture/capture-legacy")
./process_lidar_capture --input "$work/fixture/capture" --output "$work/revision" --expected-capture-id 6d8c1359-2480-4493-89b8-39be20cc6fc9
echo 'Actual Swift export passed backend validation and CPU processing.'
