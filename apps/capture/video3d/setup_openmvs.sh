#!/usr/bin/env bash
# Install the upstream CPU executables for local depth fusion, meshing and texturing.
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
  [[ -x InterfaceCOLMAP && -x DensifyPointCloud && -x ReconstructMesh && -x TextureMesh ]] || return 1
  shasum -a 256 -c --status <<'HASHES'
34d7ee529fe232dc26e23db53097ad4567aa502e9e42f901d1cb1baf613a4d98  InterfaceCOLMAP
8ea970b0349270754d23f31a11dea87417c06d1001fa1ef437ee69b6146a1ce0  DensifyPointCloud
05f0eae93628ce50fa481db2879e9f62d1636b68f06422f76fd8b5d8d4773b0e  ReconstructMesh
02887713214539f59286f8a2af430a48f6e237a5a98c8a83d050489bc426837f  TextureMesh
HASHES
)

mkdir -p "$bin_dir"
if ! verify_binaries "$bin_dir"; then
  stage="$(mktemp -d "$tools_dir/.install.XXXXXXXX")"
  trap 'rm -rf "$stage"' EXIT
  cached="$tools_dir/bootstrap/OpenMVS_macOS_arm64.zip"
  if [[ -f "$cached" ]] && printf '%s  %s\n' "$archive_sha" "$cached" | shasum -a 256 -c --status; then
    archive="$cached"
  else
    archive="$stage/openmvs.zip"
    curl --fail --location --retry 2 --output "$archive" "$release"
  fi
  (
    cd "$stage"
    printf '%s  %s\n' "$archive_sha" "$archive" | shasum -a 256 -c
    unzip -q "$archive" InterfaceCOLMAP DensifyPointCloud ReconstructMesh TextureMesh
  )
  verify_binaries "$stage"
  mv -f "$stage/InterfaceCOLMAP" "$stage/DensifyPointCloud" "$stage/ReconstructMesh" "$stage/TextureMesh" "$bin_dir/"
fi

printf 'OpenMVS %s is ready in %s\n' "$version" "$bin_dir"
