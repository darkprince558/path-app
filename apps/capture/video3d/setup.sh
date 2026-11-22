#!/usr/bin/env bash
# Local tools and viewer assets live beside the private captures.
set -euo pipefail
app="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$app/../../.." && pwd)"
cache="$root/captures-local/video3d-tools"
for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null; then
    echo "Missing $tool. Install FFmpeg 9 or newer, then rerun setup." >&2
    exit 1
  fi
done
mkdir -p "$cache"
selected="${VIDEO3D_PYTHON:-python3.12}"
if [[ -z "${VIDEO3D_PYTHON:-}" ]] && ! command -v "$selected" >/dev/null; then
  selected=python3
fi
version_check='import sys; sys.exit(sys.version_info < (3, 12))'
if ! "$selected" -c "$version_check"; then
  echo "Install Python 3.12+, or run VIDEO3D_PYTHON=/path/to/python3.12 ./hallway3d setup." >&2
  exit 1
fi
if [[ -d "$cache/.venv" ]] && ! "$cache/.venv/bin/python" -c "$version_check"; then
  old="$(mktemp -d "$cache/previous-env.XXXXXX")"
  mv "$cache/.venv" "$old/"
  echo "Saved the incompatible Python environment in $old"
fi
if [[ ! -x "$cache/.venv/bin/python" ]]; then
  "$selected" -m venv "$cache/.venv"
fi
"$cache/.venv/bin/python" -m pip install --disable-pip-version-check --only-binary=:all: -r "$app/requirements.txt"

if [[ -f "$root/apps/web/package.json" ]]; then
  web="$root/apps/web"
else
  # Arielle's guest-viewer PR #15 supplies the same route the web app serves.
  viewer_rev=14dd27012869e5500d00bd688608aee054313493
  web="$cache/viewer/apps/web"
  if ! git -C "$root" cat-file -e "$viewer_rev^{commit}" 2>/dev/null; then
    git -C "$root" fetch origin "$viewer_rev"
  fi
  mkdir -p "$cache/viewer"
  git -C "$root" archive "$viewer_rev" apps/web | tar -x -C "$cache/viewer"
fi
if ! command -v pnpm >/dev/null; then
  echo "Install Node.js 22.12+ and pnpm to build the Path guest viewer, then rerun setup." >&2
  exit 1
fi
pnpm --dir "$web" install --frozen-lockfile
pnpm --dir "$web" run build
echo "Ready. Run ./hallway3d with the path to a MOV or MP4."
