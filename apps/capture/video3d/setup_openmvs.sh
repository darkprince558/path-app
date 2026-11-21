#!/usr/bin/env bash
# Install the two upstream CPU executables used for local densification.
set -euo pipefail

if [[ "$(uname -sm)" != "Darwin arm64" ]]; then
  echo "This installer downloads the ARM64 macOS build of OpenMVS." >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/../../.." && pwd)"
tools_dir="$root/captures-local/video3d-tools/openmvs"
bin_dir="$tools_dir/env/bin"
version=2.4.0
archive_sha=3d4c616c97031b1ab6e2eecb0ddd5614fb99513c0782a32c9350602faf38799b
release="https://github.com/cdcseacave/openMVS/releases/download/v$version/OpenMVS_macOS_arm64.zip"

verify_binaries() (
  cd "$1"
  [[ -x InterfaceCOLMAP && -x DensifyPointCloud ]] || return 1
  shasum -a 256 -c --status <<'HASHES'
34d7ee529fe232dc26e23db53097ad4567aa502e9e42f901d1cb1baf613a4d98  InterfaceCOLMAP
8ea970b0349270754d23f31a11dea87417c06d1001fa1ef437ee69b6146a1ce0  DensifyPointCloud
HASHES
)

mkdir -p "$bin_dir"
if ! verify_binaries "$bin_dir"; then
  stage="$(mktemp -d "$tools_dir/.install.XXXXXXXX")"
  trap 'rm -rf "$stage"' EXIT
  curl --fail --location --retry 2 --output "$stage/openmvs.zip" "$release"
  (
    cd "$stage"
    printf '%s  openmvs.zip\n' "$archive_sha" | shasum -a 256 -c
    unzip -q openmvs.zip InterfaceCOLMAP DensifyPointCloud
  )
  verify_binaries "$stage"
  mv -f "$stage/InterfaceCOLMAP" "$stage/DensifyPointCloud" "$bin_dir/"
fi

printf 'OpenMVS %s is ready in %s\n' "$version" "$bin_dir"
