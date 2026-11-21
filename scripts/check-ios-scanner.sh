#!/bin/bash
# Verify the actual Swift exporter, native UI and Mac intake using a booted iOS simulator.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
: "${1:?Pass the UDID of a booted iOS simulator from xcrun simctl list devices booted}"
check_dir=$(mktemp -d "${TMPDIR:-/tmp}/path-capture-test.XXXXXX")
src=apps/capture/PathCapture
xcrun swiftc -O "$src/PointCloud.swift" "$src/ScanGeometry.swift" "$src/ScanRecord.swift" "$src/MacConnection.swift" apps/capture/native-tests/main.swift -o "$check_dir/export"
"$check_dir/export" "$check_dir/fixture"
python3 - "$check_dir/fixture" <<'PY'
from pathlib import Path
import sys
sys.path.insert(0,'tools')
from native_scan_asset import validate_native_model
for name in ['scene.glb','sparse.glb']:validate_native_model(Path(sys.argv[1])/name)
PY
args=(-project apps/capture/PathCapture.xcodeproj -scheme PathCapture -destination "platform=iOS Simulator,id=$1" -derivedDataPath "$check_dir/build")
xcodebuild -quiet "${args[@]}" build
xcrun simctl install "$1" "$check_dir/build/Build/Products/Debug-iphonesimulator/PathCapture.app"
container=$(xcrun simctl get_app_container "$1" com.pathapp.demo.capture data)
python3 - "$container" "$check_dir/fixture" <<'PY'
from pathlib import Path
import json,shutil,sys
scan='6D8C1359-2480-4493-89B8-39BE20CC6FC9'; dest=Path(sys.argv[1])/'Documents/Scans'/scan; dest.mkdir(parents=True,exist_ok=True)
for name in ['scene.glb','points.ply']:shutil.copyfile(Path(sys.argv[2])/name,dest/name)
(dest/'scan.json').write_text(json.dumps(dict(id=scan,created=817000000,duration=3,mode='Synthetic wall fixture',pointCount=6,triangles=3,photoFaces=2,poseCount=0,gyroCount=0,classes={'wall':2,'floor':1},hasVideo=False,partial=False)))
PY
xcodebuild -quiet "${args[@]}" -parallel-testing-enabled NO -resultBundlePath "$check_dir/review.xcresult" test
printf 'Simulator review evidence: %s\n' "$check_dir/review.xcresult"
