"""Open an exported PLY or compare two reconstructions in the Path guest viewer."""

import argparse
import io
import json
import math
import mimetypes
import os
import shutil
import struct
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
MESH_PATH = "/mesh-compare"
MESH_METADATA = "/api/mesh-comparison"
MESH_ASSET = f"{MESH_METADATA}/surface.glb"
PLANES_PATH = "/plane-compare"
PLANES_METADATA = "/api/plane-comparison"
BASELINE_ASSET = f"{PLANES_METADATA}/baseline.glb"
PLANES_ASSET = f"{PLANES_METADATA}/completed.glb"


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


def check_glb(path):
    """The local viewer accepts self-contained binary glTF, including image atlases."""
    size = path.stat().st_size
    with path.open("rb") as file:
        header = file.read(20)
        if len(header) != 20:
            raise ValueError("Truncated GLB header")
        magic, version, declared_size, json_size, chunk_type = struct.unpack("<4sIII4s", header)
        if magic != b"glTF" or version != 2 or declared_size != size or chunk_type != b"JSON":
            raise ValueError("Expected a complete GLB 2.0 file")
        if not 0 < json_size <= min(size - 20, 16 * 1024 * 1024):
            raise ValueError("Invalid GLB JSON length")
        doc = json.loads(file.read(json_size))
        if not isinstance(doc, dict) or not doc.get("meshes") or not doc.get("textures"):
            raise ValueError("Expected a textured mesh in the GLB")
        for asset in [*doc.get("images", []), *doc.get("buffers", [])]:
            if not isinstance(asset, dict):
                raise ValueError("Invalid GLB resource")
            uri = asset.get("uri")
            if uri is not None and not (isinstance(uri, str) and uri.startswith("data:")):
                raise ValueError("GLB textures and buffers must be embedded")


def build_comparison(web, stage, route=COMPARE_PATH):
    """Build an isolated comparison entry with the original guest sources and dependencies."""
    vite = web / "node_modules/.bin/vite"
    if not vite.is_file() or not (web / "src/components/ScanViewer.tsx").is_file():
        raise ValueError("Comparison needs the guest viewer sources and installed dependencies. "
                         "Run ./hallway3d setup or use --dist from a built guest workspace.")
    shutil.copytree(Path(__file__).with_name("comparison"), stage, dirs_exist_ok=True)
    if route in (MESH_PATH, PLANES_PATH):
        (stage / "mesh.html").replace(stage / "index.html")
    for relpath in ("src/components/ScanViewer.tsx", "src/lib/ply.ts", "tsconfig.json"):
        dest = stage / relpath
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(web / relpath, dest)
    (stage / "node_modules").symlink_to(web / "node_modules", target_is_directory=True)
    subprocess.run([str(vite), "build", "--base", f"{route}/", "--logLevel", "warn"],
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
            self.send_header("Location", self.server.route)
            self.end_headers()
            return None
        if path == METADATA_PATH and self.server.route != PLANES_PATH:
            data = json.dumps({"shareId": SHARE_ID, "format": "ply", "assetPath": ASSET_PATH}).encode()
            self.success("application/json", len(data))
            return io.BytesIO(data)
        if path in self.server.asset_files:
            return self.serve_file(*self.server.asset_files[path])
        route = self.server.route
        if route != GUEST_PATH:
            if path == self.server.metadata_path:
                data = json.dumps(self.server.comparison).encode()
                self.success("application/json", len(data))
                return io.BytesIO(data)
            if path in (route, route + "/"):
                return self.serve_file(self.server.compare_dist / "index.html", "text/html; charset=utf-8")
            if path.startswith(route + "/assets/"):
                return self.serve_asset(self.server.compare_dist, path[len(route):])
        if path == GUEST_PATH and route != PLANES_PATH:
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
    parser.add_argument("scan", type=Path, help="exported .ply file, or the original .glb for --planes")
    compare_options = parser.add_mutually_exclusive_group()
    compare_options.add_argument("--compare", type=Path, metavar="OPENMVS.ply",
                        help="compare the positional stereo PLY with an OpenMVS PLY in the same coordinates")
    compare_options.add_argument("--mesh", type=Path, metavar="SURFACE.glb",
                                 help="display the positional point cloud beside its textured GLB mesh")
    compare_options.add_argument("--planes", type=Path, metavar="COMPLETED.glb",
                                 help="show the original and plane-completed GLBs side by side")
    parser.add_argument("--report", type=Path, help="comparison report with optional camera_views")
    parser.add_argument("--dist", type=Path, help="built Path guest viewer dist directory")
    parser.add_argument("--port", type=int, default=8765, help="localhost TCP port (0 selects a free port)")
    parser.add_argument("--no-open", action="store_true", help="print the URL without opening the browser")
    args = parser.parse_args()
    scan = args.scan.expanduser().resolve()
    first_suffix = ".glb" if args.planes else ".ply"
    if not scan.is_file() or scan.suffix.lower() != first_suffix:
        parser.error(f"Expected an existing {first_suffix} file: {scan}")
    compare = args.compare.expanduser().resolve() if args.compare else None
    if compare and (not compare.is_file() or compare.suffix.lower() != ".ply"):
        parser.error(f"Expected an existing comparison .ply file: {compare}")
    mesh = args.mesh.expanduser().resolve() if args.mesh else None
    planes = args.planes.expanduser().resolve() if args.planes else None
    for glb in ([scan, planes] if planes else [mesh] if mesh else []):
        if not glb.is_file() or glb.suffix.lower() != ".glb":
            parser.error(f"Expected an existing textured .glb file: {glb}")
        try:
            check_glb(glb)
        except (OSError, ValueError, TypeError) as error:
            parser.error(f"Could not open the mesh: {error}")
    if args.report and not (compare or mesh or planes):
        parser.error("--report requires --compare, --mesh or --planes")
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
        route, metadata_path = GUEST_PATH, None
        files = {ASSET_PATH: (scan, "application/octet-stream")}
        if planes:
            route, metadata_path = PLANES_PATH, PLANES_METADATA
            files = {BASELINE_ASSET: (scan, "model/gltf-binary"), PLANES_ASSET: (planes, "model/gltf-binary")}
        elif mesh:
            route, metadata_path = MESH_PATH, MESH_METADATA
            files[MESH_ASSET] = (mesh, "model/gltf-binary")
        elif compare:
            route, metadata_path = COMPARE_PATH, "/api/comparison"
            files[SECOND_ASSET] = (compare, "application/octet-stream")
        other = planes or mesh or compare
        if other:
            report = args.report.expanduser() if args.report else None
            if report is None and planes:
                report = planes.parent / "report.json"
            elif report is None and scan.parent == other.parent:
                report = scan.parent / "report.json"
            try:
                metadata = comparison_metadata(report, args.report is not None)
                if planes:
                    metadata = {"baseline": BASELINE_ASSET, "mesh": PLANES_ASSET, "views": metadata["views"]}
                elif mesh:
                    metadata = {"points": ASSET_PATH, "mesh": MESH_ASSET, "views": metadata["views"]}
                stage = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="path-compare-")))
                comparison_dist = build_comparison(dist.parent, stage, route)
            except (OSError, ValueError, subprocess.CalledProcessError) as error:
                parser.exit(1, f"Could not prepare comparison: {error}\n")
        try:
            server = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", args.port), PreviewHandler))
        except OSError as error:
            parser.exit(1, f"Could not start the local preview: {error}. Try --port 0.\n")
        server.dist, server.route, server.metadata_path = dist, route, metadata_path
        server.asset_files = files
        server.compare_dist, server.comparison = comparison_dist, metadata
        url = f"http://127.0.0.1:{server.server_port}{route}"
        print(f"Previewing {scan.name} at {url}\nPress Ctrl-C to stop.", flush=True)
        if not args.no_open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
