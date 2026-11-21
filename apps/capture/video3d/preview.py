"""Open an exported PLY or compare two reconstructions in the Path guest viewer."""

import argparse
import io
import json
import math
import mimetypes
import os
import shutil
import subprocess
import tempfile
import webbrowser
from contextlib import ExitStack
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[3]
SHARE_ID = "local"
GUEST_PATH = f"/s/{SHARE_ID}"
METADATA_PATH = f"/api/shares/{SHARE_ID}"
ASSET_PATH = f"{METADATA_PATH}/asset"
COMPARE_PATH = "/compare"
SECOND_ASSET = "/api/comparison/openmvs"


def comparison_metadata(report, explicit):
    """Expose only the viewer fields from a local report."""
    payload = {"assets": [ASSET_PATH, SECOND_ASSET], "labels": ["Stereo", "OpenMVS"], "views": []}
    if report is None or (not explicit and not report.exists()):
        return payload
    data = json.loads(report.read_text())
    if not isinstance(data, dict) or not isinstance(data.get("camera_views", []), list):
        raise ValueError(f"Invalid comparison report: {report}")
    exports = data.get("exports")
    stereo = exports.get("stereo") if isinstance(exports, dict) else None
    if isinstance(stereo, dict) and stereo.get("geometry") == "sparse":
        payload["labels"][0] = "Sparse fallback"
    for view in data.get("camera_views", []):
        if not isinstance(view, dict):
            raise ValueError(f"Invalid capture view in {report}")
        vectors = []
        for key in ("position", "target", "up"):
            coords = view.get(key)
            if (not isinstance(coords, list) or len(coords) != 3
                    or not all(isinstance(v, (float, int)) and math.isfinite(v) for v in coords)):
                raise ValueError(f"Invalid capture view {key} in {report}")
            vectors.append(coords)
        position, target, up = vectors
        if math.dist(position, target) < 1e-8 or math.hypot(*up) < 1e-8:
            raise ValueError(f"Invalid capture orientation in {report}")
        label = view.get("label")
        if not isinstance(label, str) or not label:
            raise ValueError(f"Missing capture view label in {report}")
        payload["views"].append({"label": label, "position": position, "target": target, "up": up})
    return payload


def build_comparison(web, stage):
    """Build an isolated comparison entry with the original guest sources and dependencies."""
    vite = web / "node_modules/.bin/vite"
    if not vite.is_file() or not (web / "src/components/ScanViewer.tsx").is_file():
        raise ValueError("Comparison needs the guest viewer sources and installed dependencies. "
                         "Run ./hallway3d setup or use --dist from a built guest workspace.")
    shutil.copytree(Path(__file__).with_name("comparison"), stage, dirs_exist_ok=True)
    for relpath in ("src/components/ScanViewer.tsx", "src/lib/ply.ts", "tsconfig.json"):
        dest = stage / relpath
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(web / relpath, dest)
    (stage / "node_modules").symlink_to(web / "node_modules", target_is_directory=True)
    subprocess.run([str(vite), "build", "--base", "/compare/", "--logLevel", "warn"],
                   cwd=stage, check=True)
    return (stage / "dist").resolve()


class PreviewHandler(SimpleHTTPRequestHandler):
    """Serve the viewer bundle and expose only the selected scan."""

    def send_head(self):
        host = self.headers.get("Host")
        port = self.server.server_port
        if host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            self.send_error(403, "Use the local preview URL")
            return None

        path = unquote(urlsplit(self.path).path)
        if path == "/":
            self.send_response(302)
            self.send_header("Location", COMPARE_PATH if self.server.compare else GUEST_PATH)
            self.end_headers()
            return None
        if path == METADATA_PATH:
            data = json.dumps({"shareId": SHARE_ID, "format": "ply", "assetPath": ASSET_PATH}).encode()
            self.success("application/json", len(data))
            return io.BytesIO(data)
        if path == ASSET_PATH:
            return self.serve_file(self.server.scan, "application/octet-stream")
        if self.server.compare:
            if path == "/api/comparison":
                data = json.dumps(self.server.comparison).encode()
                self.success("application/json", len(data))
                return io.BytesIO(data)
            if path == SECOND_ASSET:
                return self.serve_file(self.server.compare, "application/octet-stream")
            if path in (COMPARE_PATH, COMPARE_PATH + "/"):
                return self.serve_file(self.server.compare_dist / "index.html", "text/html; charset=utf-8")
            if path.startswith("/compare/assets/"):
                return self.serve_asset(self.server.compare_dist, path[len(COMPARE_PATH):])
        if path == GUEST_PATH:
            return self.serve_file(self.server.dist / "index.html", "text/html; charset=utf-8")
        if path.startswith("/assets/"):
            return self.serve_asset(self.server.dist, path)
        self.send_error(404)
        return None

    def serve_asset(self, dist, path):
        if "\x00" not in path:
            file = (dist / path.lstrip("/")).resolve()
            if file.is_relative_to(dist / "assets") and file.is_file():
                return self.serve_file(file, mimetypes.guess_type(file)[0] or "application/octet-stream")
        self.send_error(404)
        return None

    def success(self, content_type, size):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()

    def serve_file(self, path, content_type):
        try:
            file = path.open("rb")
        except OSError:
            self.send_error(404)
            return None
        self.success(content_type, os.fstat(file.fileno()).st_size)
        return file  # SimpleHTTPRequestHandler streams and closes the open file.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scan", type=Path, help="exported .ply file")
    parser.add_argument("--compare", type=Path, metavar="OPENMVS.ply",
                        help="compare the positional stereo PLY with an OpenMVS PLY in the same coordinates")
    parser.add_argument("--report", type=Path, help="comparison report with optional camera_views")
    parser.add_argument("--dist", type=Path, help="built Path guest viewer dist directory")
    parser.add_argument("--port", type=int, default=8765, help="localhost TCP port (0 selects a free port)")
    parser.add_argument("--no-open", action="store_true", help="print the URL without opening the browser")
    args = parser.parse_args()
    scan = args.scan.expanduser().resolve()
    if not scan.is_file() or scan.suffix.lower() != ".ply":
        parser.error(f"Expected an existing .ply file: {scan}")
    compare = args.compare.expanduser().resolve() if args.compare else None
    if compare and (not compare.is_file() or compare.suffix.lower() != ".ply"):
        parser.error(f"Expected an existing comparison .ply file: {compare}")
    if args.report and not compare:
        parser.error("--report requires --compare")
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")

    candidates = [args.dist.expanduser()] if args.dist else [
        ROOT / "apps/web/dist",
        ROOT / "captures-local/video3d-tools/viewer/apps/web/dist",
    ]
    dist = next((p.resolve() for p in candidates if (p / "index.html").is_file()), None)
    if dist is None:
        parser.error("Missing built guest viewer. Build apps/web from the guest-viewer branch "
                     "with pnpm install and pnpm build, then pass --dist /path/to/apps/web/dist.")

    with ExitStack() as stack:
        comparison_dist, metadata = None, None
        if compare:
            report = args.report.expanduser() if args.report else None
            if report is None and scan.parent == compare.parent:
                report = scan.parent / "report.json"
            try:
                metadata = comparison_metadata(report, args.report is not None)
                stage = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="path-compare-")))
                comparison_dist = build_comparison(dist.parent, stage)
            except (OSError, ValueError, subprocess.CalledProcessError) as error:
                parser.exit(1, f"Could not prepare comparison: {error}\n")
        try:
            server = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", args.port), PreviewHandler))
        except OSError as error:
            parser.exit(1, f"Could not start the local preview: {error}. Try --port 0.\n")
        server.scan, server.dist = scan, dist
        server.compare, server.compare_dist, server.comparison = compare, comparison_dist, metadata
        url = f"http://127.0.0.1:{server.server_port}{COMPARE_PATH if compare else GUEST_PATH}"
        print(f"Previewing {scan.name} at {url}\nPress Ctrl-C to stop.", flush=True)
        if not args.no_open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
