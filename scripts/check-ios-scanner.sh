#!/bin/bash
# Verify the actual Swift exporter, native UI and Mac intake using a booted iOS simulator.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
: "${1:?Pass the UDID of a booted iOS simulator from xcrun simctl list devices booted}"
check_dir=$(mktemp -d "${TMPDIR:-/tmp}/path-capture-test.XXXXXX")
src=apps/capture/PathCapture
xcrun swiftc -O "$src/PointCloud.swift" "$src/ScanGeometry.swift" "$src/ScanRecord.swift" "$src/CaptureBundle.swift" "$src/MacConnection.swift" apps/capture/native-tests/main.swift -o "$check_dir/export"
"$check_dir/export" "$check_dir/fixture"
python3 - "$check_dir/fixture" <<'PY'
import json
from pathlib import Path
import sys
sys.path.insert(0,'tools')
from native_scan_asset import validate_native_model
for name in ['scene.glb','sparse.glb']:validate_native_model(Path(sys.argv[1])/name)
capture = Path(sys.argv[1]) / 'capture'
frames = json.loads((capture / 'frames.json').read_text())['frames']
assert [f['frameId'] for f in frames] == ['frame-0000', 'frame-0007']
for f, number, seconds in zip(frames, [0, 7], [0.25, 1.2504]):
    assert f['imagePath'] == f['path'] == f"frames/{f['frameId']}.jpg"
    assert (capture / f['imagePath']).read_bytes() == (capture.parent / 'bundle-take' / f'photo-{number}.jpg').read_bytes()
    assert f['mimeType'] == 'image/jpeg' and (f['width'], f['height']) == (64, 64)
    assert f['trackingState'] == 'normal'
    assert f['timestampSeconds'] == seconds and f['timestampMs'] == round(seconds * 1000)
    assert f['cameraToWorld'] == f['cameraPose'] and len(f['cameraToWorld']) == 16
    assert f['intrinsics'] == {'fx': 48, 'fy': 50, 'cx': 30, 'cy': 33}
assert abs(frames[1]['cameraToWorld'][12] - 0.2) < 1e-6
PY
args=(-project apps/capture/PathCapture.xcodeproj -scheme PathCapture -destination "platform=iOS Simulator,id=$1" -derivedDataPath "$check_dir/build")
xcodebuild -quiet "${args[@]}" build
xcrun simctl install "$1" "$check_dir/build/Build/Products/Debug-iphonesimulator/PathCapture.app"
container=$(xcrun simctl get_app_container "$1" com.pathapp.demo.capture data)
python3 - "$container" "$check_dir/fixture" <<'PY'
from pathlib import Path
import shutil,sys
scan='6D8C1359-2480-4493-89B8-39BE20CC6FC9'
dest=Path(sys.argv[1])/'Documents/Scans'/scan
shutil.copytree(Path(sys.argv[2])/'bundle-take', dest, dirs_exist_ok=True)
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
archives = Path(sys.argv[1]).glob('*/capture-b4ca8f7e-14a8-4fdc-9e54-0ea7936ff501.zip')
with ZipFile(max(archives, key=lambda p: p.stat().st_mtime_ns)) as archive:
    expected = {'capture/' + name for name in (
        'manifest.json', 'source.glb', 'points.ply', 'frames.json', 'preview.jpg',
        'frames/frame-0000.jpg', 'frames/frame-0007.jpg')}
    assert {name for name in archive.namelist() if not name.endswith('/')} == expected
    for name in expected:
        archive.extract(name, sys.argv[2])
PY
  "$2" --input "$check_dir/unpacked/capture" --output "$check_dir/revision" \
    --expected-capture-id b4ca8f7e-14a8-4fdc-9e54-0ea7936ff501
fi
