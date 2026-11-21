#!/bin/bash
# Install a development-signed Path Capture build on one connected, paired iPhone/iPad.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
if [[ ${1:-} == --help ]]; then
  echo 'Usage: scripts/install-ios-scanner.sh [device name or UDID]'
  echo 'Unlock the phone, trust this Mac and enable Developer Mode. DEVELOPMENT_TEAM can override the local Apple development team.'
  exit 0
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/path-install.XXXXXX")
xcrun devicectl list devices --json-output "$scratch/devices.json" >/dev/null
device=$(python3 - "$scratch/devices.json" "${1:-}" <<'PY'
import json,sys
requested=sys.argv[2].lower()
devices=json.load(open(sys.argv[1]))['result']['devices']
options=[]
for dev in devices:
    hw, con, props=dev['hardwareProperties'], dev['connectionProperties'], dev['deviceProperties']
    if hw.get('reality')!='physical' or hw.get('platform')!='iOS':continue
    if requested and requested not in [str(v).lower() for v in (dev.get('identifier'),hw.get('udid'),props.get('name'))]:continue
    if con.get('tunnelState')=='connected' or con.get('transportType')=='wired':options.append(dev)
if len(options)!=1:sys.exit('Connect and unlock one paired iPhone or iPad, or specify its device name. Check Xcode > Window > Devices and Simulators before retrying.')
dev=options[0]
if dev['deviceProperties'].get('developerModeStatus')=='disabled':sys.exit('Enable Developer Mode in Settings > Privacy & Security, restart the phone, then run again.')
print(dev['hardwareProperties']['udid'])
PY
)
team=${DEVELOPMENT_TEAM:-}
if [[ -z "$team" ]]; then
  team=$(security find-certificate -c 'Apple Development' -p | openssl x509 -noout -subject -nameopt multiline | awk '/organizationalUnitName/{print $NF; exit}')
fi
[[ -n "$team" ]] || { echo 'Choose your Apple Development team in Xcode or supply DEVELOPMENT_TEAM.' >&2; exit 1; }
xcodebuild -quiet -project "$root/apps/capture/PathCapture.xcodeproj" -scheme PathCapture -configuration Release \
  -destination "id=$device" -derivedDataPath "$scratch/build" DEVELOPMENT_TEAM="$team" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
app="$scratch/build/Build/Products/Release-iphoneos/PathCapture.app"
codesign --verify --deep --strict "$app"
xcrun devicectl device install app --device "$device" "$app"
bundle=$(plutil -extract CFBundleIdentifier raw "$app/Info.plist")
xcrun devicectl device process launch --device "$device" "$bundle"
