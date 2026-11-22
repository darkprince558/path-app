#!/usr/bin/env python3
"""Loopback upload/share mock. Assets live only for this server session."""

import argparse
import json
import re
import secrets
import struct
import time
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlsplit


MAX_UPLOAD_BYTES = 400 * 1024 * 1024
SHARE_ID = r"[a-f0-9]{32}"
DEV_ID = r"[a-zA-Z0-9_.@-]{1,64}"
VISIBILITIES = ("private", "unlisted", "public")
MAX_NAME_LENGTH = 80
DEFAULT_NAME = "Untitled map"
PATCH_FIELDS = {"name", "visibility", "viewerIds"}
CUE_ID = r"[a-f0-9]{32}"
CUE_STATUSES = ("draft", "approved", "rejected")
MAX_INSTRUCTION_LENGTH = 200


def demo_cues():
    """Two Gemini-style drafts for the venue fixture's junction (see fixtures/README.md)."""
    return [
        {"id": secrets.token_hex(16), "routeSegmentId": "entrance-junction", "sequence": 0, "landmark": "amber workshop doorway",
         "instruction": "Turn left at the amber workshop doorway.", "confidence": "high", "status": "draft",
         "sourceFrameIds": ["frame-0000"]},
        {"id": secrets.token_hex(16), "routeSegmentId": "junction-booth", "sequence": 1, "landmark": "purple booth doorway",
         "instruction": "Turn right toward the purple booth doorway.", "confidence": "medium", "status": "draft",
         "sourceFrameIds": ["frame-0007"]},
    ]


def now():
    """Returns (sort key, ISO 8601 UTC string) for created/updated times."""
    return time.time_ns(), datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def clean_name(value):
    """A map name: 1-80 characters after trimming, no control characters. None if invalid."""
    if not isinstance(value, str):
        return None
    name = " ".join(value.split())
    if not 1 <= len(name) <= MAX_NAME_LENGTH or any(ord(c) < 32 or ord(c) == 127 for c in name):
        return None
    return name


@dataclass(frozen=True)
class Scan:
    path: Path
    owner: str
    visibility: str
    viewers: frozenset
    name: str = DEFAULT_NAME
    updated_ns: int = 0
    updated_at: str = ""

    def visible_to(self, user):
        return self.visibility != "private" or self.owner == user or user in self.viewers

    @property
    def format(self):
        return self.path.suffix[1:]

    def summary(self, share_id):
        """What anyone allowed to see the scan in a list may know about it."""
        return {"shareId": share_id, "sharePath": f"/s/{share_id}", "name": self.name,
                "format": self.format, "visibility": self.visibility, "updatedAt": self.updated_at}

    def sharing(self, share_id):
        """The owner's view: includes the complete viewer list."""
        return {**self.summary(share_id), "viewerIds": sorted(self.viewers)}


def valid_header(data, file_format):
    if file_format == "glb":
        return (len(data) >= 20 and data[:4] == b"glTF"
                and struct.unpack_from("<II", data, 4) == (2, len(data))
                and data[16:20] == b"JSON")
    lines = data[:65536].splitlines()
    return (len(lines) >= 3 and lines[0] == b"ply"
            and lines[1] in (b"format ascii 1.0", b"format binary_little_endian 1.0",
                             b"format binary_big_endian 1.0")
            and b"end_header" in lines)


class ScanServer(ThreadingHTTPServer):
    def __init__(self, port, directory, with_demo_cues=False):
        self.directory = Path(directory)
        self.scans = {}
        # Landmark cues per share (the mock uses the share ID as its revision ID). Only with --demo-cues.
        self.with_demo_cues = with_demo_cues
        self.cues = {}
        super().__init__(("127.0.0.1", port), ScanHandler)

    def newest_first(self, keep):
        """Lists (share_id, scan) pairs that pass `keep`, most recently changed first."""
        pairs = [(key, scan) for key, scan in self.scans.copy().items() if keep(scan)]
        return sorted(pairs, key=lambda pair: pair[1].updated_ns, reverse=True)


class ScanHandler(BaseHTTPRequestHandler):
    def reply(self, status, media_type, body, attachment=None):
        self.send_response(status)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if attachment:
            self.send_header("Content-Disposition", f'attachment; filename="{attachment}"')
        self.end_headers()
        self.wfile.write(body)

    def json_reply(self, status, payload):
        self.reply(status, "application/json", json.dumps(payload).encode())

    def user(self):
        identifier = self.headers.get("X-Dev-User", "")
        return identifier if re.fullmatch(DEV_ID, identifier) else None

    def read_body(self, limit):
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths or "Transfer-Encoding" in self.headers:
            return self.json_reply(411, {"error": "Content-Length required"})
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,18}", lengths[0]):
            return self.json_reply(400, {"error": "Invalid Content-Length"})
        size = int(lengths[0])
        if size > limit:
            return self.json_reply(413, {"error": "Request size limit exceeded"})
        data = self.rfile.read(size)
        if len(data) != size:
            return self.json_reply(400, {"error": "Incomplete request"})
        return data

    def reject(self, status, message):
        """Answers an error before the body was read. A small unread body is drained first,
        because closing a socket with unread data makes Windows reset the connection
        before the client can read the error."""
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) == 1 and re.fullmatch(r"[0-9]{1,7}", lengths[0]) and int(lengths[0]) <= 1024 * 1024:
            self.rfile.read(int(lengths[0]))
        return self.json_reply(status, {"error": message})

    def owned_scan(self):
        """The scan named in /api/scans/<id> if the caller owns it, else (None, None)."""
        match = re.fullmatch(rf"/api/scans/({SHARE_ID})", urlsplit(self.path).path)
        share_id = match.group(1) if match else ""
        scan = self.server.scans.get(share_id)
        if scan is None or self.user() != scan.owner:
            return None, None
        return share_id, scan

    def do_POST(self):
        target = urlsplit(self.path)
        if target.path != "/api/scans":
            return self.reject(404, "Unknown endpoint")
        user = self.user()
        if user is None:
            return self.reject(401, "X-Dev-User required")
        params = parse_qs(target.query, keep_blank_values=True)
        if (params.keys() - {"format", "visibility", "name"} or
                any(len(values) != 1 for values in params.values())):
            return self.reject(400, "Invalid query")
        file_format = params.get("format", [""])[0]
        visibility = params.get("visibility", ["private"])[0]
        if file_format not in ("ply", "glb") or visibility not in VISIBILITIES:
            return self.reject(400, "Invalid format or visibility")
        content_type = self.headers.get_content_type()
        if content_type != "application/octet-stream" and not (
            file_format == "glb" and content_type == "model/gltf-binary"
        ):
            return self.reject(415, "Expected raw model bytes")
        data = self.read_body(MAX_UPLOAD_BYTES)
        if data is None:
            return
        # Checked after reading the body, so the client gets a clean 400 instead of a reset connection.
        name = clean_name(params["name"][0]) if "name" in params else DEFAULT_NAME
        if name is None:
            return self.json_reply(400, {"error": f"Name must be 1-{MAX_NAME_LENGTH} characters"})
        if not valid_header(data, file_format):
            return self.json_reply(400, {"error": "Invalid model header"})
        share_id = secrets.token_hex(16)
        path = self.server.directory / f"{share_id}.{file_format}"
        path.write_bytes(data)
        updated_ns, updated_at = now()
        self.server.scans[share_id] = Scan(path, user, visibility, frozenset(), name, updated_ns, updated_at)
        if self.server.with_demo_cues:
            self.server.cues[share_id] = demo_cues()
        self.json_reply(201, {"shareId": share_id, "sharePath": f"/s/{share_id}", "name": name})

    def patch_cue(self, cue_id):
        """PATCH /api/cues/<id> with {instruction?, status?}: the owner edits, approves or rejects."""
        found = next(((key, cue) for key, cues in self.server.cues.copy().items() for cue in cues
                      if cue["id"] == cue_id), None)
        scan = self.server.scans.get(found[0]) if found else None
        if scan is None or self.user() != scan.owner:
            return self.reject(404, "Unknown cue")
        data = self.read_body(16 * 1024)
        if data is None:
            return
        try:
            change = json.loads(data)
        except (ValueError, RecursionError):
            return self.json_reply(400, {"error": "Invalid JSON"})
        if not isinstance(change, dict) or not change or set(change) - {"instruction", "status"}:
            return self.json_reply(400, {"error": "Expected instruction or status"})
        cue = dict(found[1])
        if "instruction" in change:
            text = " ".join(change["instruction"].split()) if isinstance(change["instruction"], str) else ""
            if not 1 <= len(text) <= MAX_INSTRUCTION_LENGTH or any(ord(c) < 32 or ord(c) == 127 for c in text):
                return self.json_reply(400, {"error": f"Instruction must be 1-{MAX_INSTRUCTION_LENGTH} characters"})
            cue["instruction"] = text
        if "status" in change:
            if change["status"] not in CUE_STATUSES:
                return self.json_reply(400, {"error": "Invalid status"})
            cue["status"] = change["status"]
        self.server.cues[found[0]] = [cue if c["id"] == cue_id else c for c in self.server.cues[found[0]]]
        self.json_reply(200, {"cue": cue})

    def do_PATCH(self):
        cue_match = re.fullmatch(rf"/api/cues/({CUE_ID})", urlsplit(self.path).path)
        if cue_match:
            return self.patch_cue(cue_match.group(1))
        share_id, scan = self.owned_scan()
        if scan is None:
            return self.reject(404, "Unknown scan")
        if self.headers.get_content_type() != "application/json":
            return self.reject(415, "Expected application/json")
        data = self.read_body(16 * 1024)
        if data is None:
            return
        try:
            change = json.loads(data)
        except (ValueError, RecursionError):
            return self.json_reply(400, {"error": "Invalid JSON"})
        # Send any of name, visibility and viewerIds. viewerIds is always the complete list.
        if not isinstance(change, dict) or not change or set(change) - PATCH_FIELDS:
            return self.json_reply(400, {"error": "Expected name, visibility or viewerIds"})
        name = clean_name(change["name"]) if "name" in change else scan.name
        if name is None:
            return self.json_reply(400, {"error": f"Name must be 1-{MAX_NAME_LENGTH} characters"})
        visibility = change.get("visibility", scan.visibility)
        viewers = change.get("viewerIds", sorted(scan.viewers))
        if (visibility not in VISIBILITIES or not isinstance(viewers, list) or
                any(not isinstance(v, str) or not re.fullmatch(DEV_ID, v) for v in viewers)):
            return self.json_reply(400, {"error": "Invalid visibility or viewer ID"})
        updated_ns, updated_at = now()
        scan = replace(scan, name=name, visibility=visibility, viewers=frozenset(viewers),
                       updated_ns=updated_ns, updated_at=updated_at)
        self.server.scans[share_id] = scan
        self.json_reply(200, {"shareId": share_id, "name": scan.name, "visibility": scan.visibility,
                              "viewerIds": sorted(scan.viewers)})

    def do_DELETE(self):
        share_id, scan = self.owned_scan()
        if scan is None:
            return self.json_reply(404, {"error": "Unknown scan"})
        self.server.scans.pop(share_id, None)
        scan.path.unlink(missing_ok=True)
        self.reply(204, "application/json", b"")

    def do_GET(self):
        target = urlsplit(self.path).path
        if target == "/api/scans/public":
            scans = [{"shareId": key, "sharePath": f"/s/{key}", "name": scan.name, "updatedAt": scan.updated_at}
                     for key, scan in self.server.newest_first(lambda s: s.visibility == "public")]
            return self.json_reply(200, {"scans": scans})
        if target in ("/api/scans/mine", "/api/scans/shared"):
            user = self.user()
            if user is None:
                return self.json_reply(401, {"error": "X-Dev-User required"})
            if target.endswith("/mine"):
                scans = [{**scan.sharing(key), **({"revisionId": key} if key in self.server.cues else {})}
                         for key, scan in self.server.newest_first(lambda s: s.owner == user)]
            else:
                scans = [{**scan.summary(key), "owner": scan.owner} for key, scan in
                         self.server.newest_first(lambda s: user in s.viewers and s.owner != user)]
            return self.json_reply(200, {"scans": scans})
        cues_match = re.fullmatch(rf"/api/(scan-revisions|shares)/({SHARE_ID})/cues", target)
        if cues_match:
            kind, share_id = cues_match.groups()
            scan = self.server.scans.get(share_id)
            if kind == "scan-revisions":
                # The owner sees drafts and decisions.
                if scan is None or self.user() != scan.owner or share_id not in self.server.cues:
                    return self.json_reply(404, {"error": "Unknown revision"})
                return self.json_reply(200, {"cues": self.server.cues[share_id]})
            # Anyone who may open the share sees approved directions only.
            if scan is None or not scan.visible_to(self.user()):
                return self.json_reply(404, {"error": "Unknown share"})
            approved = [c for c in self.server.cues.get(share_id, []) if c["status"] == "approved"]
            return self.json_reply(200, {"cues": approved})
        match = re.fullmatch(rf"/api/shares/({SHARE_ID})(/asset)?|/s/({SHARE_ID})", target)
        if not match:
            return self.json_reply(404, {"error": "Unknown share"})
        api_id, asset_request, page_id = match.groups()
        share_id = api_id or page_id
        scan = self.server.scans.get(share_id)
        if scan is None or not scan.visible_to(self.user()):
            return self.json_reply(404, {"error": "Unknown share"})
        path = scan.path
        file_format = scan.format
        asset_path = f"/api/shares/{share_id}/asset"
        if page_id:
            page = ('<!doctype html><title>Shared scan</title><h1>Shared scan</h1>'
                    '<p>Development upload and download check. The website will render this asset in 3D.</p>'
                    f'<a href="{asset_path}">Download {file_format.upper()} scan</a>')
            return self.reply(200, "text/html; charset=utf-8", page.encode())
        if asset_request:
            media_type = "model/gltf-binary" if file_format == "glb" else "application/octet-stream"
            return self.reply(200, media_type, path.read_bytes(), f"scan.{file_format}")
        metadata = {"shareId": share_id, "format": file_format, "assetPath": asset_path, "name": scan.name}
        if share_id in self.server.cues:
            metadata["revisionId"] = share_id
        self.json_reply(200, metadata)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--demo-cues", action="store_true",
                        help="give every upload two draft landmark cues, for the review screens")
    args = parser.parse_args()
    with TemporaryDirectory() as directory, ScanServer(args.port, directory, args.demo_cues) as server:
        print(f"Scan mock listening on http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
