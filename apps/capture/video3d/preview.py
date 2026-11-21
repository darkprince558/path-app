"""Open one exported PLY in the Path guest viewer on this Mac."""

import argparse
import io
import json
import mimetypes
import os
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[3]
SHARE_ID = "local"
GUEST_PATH = f"/s/{SHARE_ID}"
METADATA_PATH = f"/api/shares/{SHARE_ID}"
ASSET_PATH = f"{METADATA_PATH}/asset"


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
            self.send_header("Location", GUEST_PATH)
            self.end_headers()
            return None
        if path == METADATA_PATH:
            data = json.dumps({"shareId": SHARE_ID, "format": "ply", "assetPath": ASSET_PATH}).encode()
            self.success("application/json", len(data))
            return io.BytesIO(data)
        if path == ASSET_PATH:
            return self.serve_file(self.server.scan, "application/octet-stream")
        if path == GUEST_PATH:
            return self.serve_file(self.server.dist / "index.html", "text/html; charset=utf-8")
        if path.startswith("/assets/") and "\x00" not in path:
            file = (self.server.dist / path.lstrip("/")).resolve()
            if file.is_relative_to(self.server.dist / "assets") and file.is_file():
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
    parser.add_argument("--dist", type=Path, help="built Path guest viewer dist directory")
    parser.add_argument("--port", type=int, default=8765, help="localhost TCP port (0 selects a free port)")
    parser.add_argument("--no-open", action="store_true", help="print the URL without opening the browser")
    args = parser.parse_args()
    scan = args.scan.expanduser().resolve()
    if not scan.is_file() or scan.suffix.lower() != ".ply":
        parser.error(f"Expected an existing .ply file: {scan}")
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

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), PreviewHandler)
    except OSError as error:
        parser.exit(1, f"Could not start the local preview: {error}. Try --port 0.\n")
    with server:
        server.scan, server.dist = scan, dist
        url = f"http://127.0.0.1:{server.server_port}{GUEST_PATH}"
        print(f"Previewing {scan.name} at {url}\nPress Ctrl-C to stop.", flush=True)
        if not args.no_open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
