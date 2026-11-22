#!/bin/bash
# Verify the actual Swift exporter, native UI and Mac intake using a booted iOS simulator.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
: "${1:?Pass the UDID of a booted iOS simulator from xcrun simctl list devices booted}"
check_dir=$(mktemp -d "${TMPDIR:-/tmp}/path-capture-test.XXXXXX")
src=apps/capture/PathCapture
xcrun swiftc -O "$src/WalkMap.swift" "$src/MapCamera.swift" "$src/SideGuidance.swift" "$src/ScanSource.swift" "$src/ReplaySource.swift" "$src/PointCloud.swift" "$src/ScanGeometry.swift" "$src/WalkSensors.swift" "$src/ScanRecord.swift" "$src/CaptureBundle.swift" "$src/MacConnection.swift" apps/capture/native-tests/SensorChecks.swift apps/capture/native-tests/main.swift -o "$check_dir/export"
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
scan='6D8C1359-2480-4493-89B8-39BE20CC6FC9'
dest=Path(sys.argv[1])/'Documents/Scans'/scan
shutil.copytree(Path(sys.argv[2])/'bundle-take', dest, dirs_exist_ok=True)
for number, suffix in enumerate(("01","02"),1):
    scan_id = "6136293B-0E77-45A2-BD95-E133AE61FC" + suffix
    folder = dest.parent/scan_id
    shutil.copytree(dest, folder, dirs_exist_ok=True)
    record = json.loads((folder/"scan.json").read_text())
    record.update(id=scan_id,walkID="9577C372-B6A3-45D9-893C-A21D22671EC4",sectionNumber=number, created=record["created"]+number)
    (folder/"scan.json").write_text(json.dumps(record))
    shutil.copyfile(Path(sys.argv[2])/"walk-map.json",folder/"walk-map.json")

PY
xcodebuild -quiet "${args[@]}" -parallel-testing-enabled NO -resultBundlePath "$check_dir/review.xcresult" test
printf 'Simulator review evidence: %s\n' "$check_dir/review.xcresult"
if [[ -n ${2:-} ]]; then
  container=$(xcrun simctl get_app_container "$1" com.pathapp.demo.capture data)
  python3 - "$container/tmp" "$check_dir/unpacked" <<'PY'
from pathlib import Path
from zipfile import ZipFile
import sys
# Only the simulator test's known synthetic capture UUID and file inventory.
archives = Path(sys.argv[1]).glob('*/capture-6d8c1359-2480-4493-89b8-39be20cc6fc9.zip')
with ZipFile(max(archives, key=lambda p: p.stat().st_mtime_ns)) as archive:
    expected = {'capture/' + name for name in (
        'manifest.json', 'source.glb', 'points.ply', 'frames.json', 'preview.jpg',
        'frames/frame-0000.jpg', 'frames/frame-0007.jpg')}
    assert {name for name in archive.namelist() if not name.endswith('/')} == expected
    for name in expected:
        archive.extract(name, sys.argv[2])
PY
  "$2" --input "$check_dir/unpacked/capture" --output "$check_dir/revision" \
    --expected-capture-id 6d8c1359-2480-4493-89b8-39be20cc6fc9
fi
