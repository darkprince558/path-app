#!/usr/bin/env python3
"""Serve the Path website, run captures on this Mac and share completed GLBs."""
import argparse
import fcntl
import hashlib
import hmac
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import ssl
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

VIDEO3D = Path(__file__).resolve().parents[1] / "apps/capture/video3d"
sys.path.insert(0, str(VIDEO3D))
from native_scan_asset import validate_native_model
from preview import check_glb
from recorded_take import CaptureError, process_capture, validate_motion

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
SHARE = r"[0-9a-f]{32}"
VIDEO_LIMIT = 240 * 1024 * 1024
MOTION_LIMIT = 12 * 1024 * 1024
LOG = logging.getLogger("recorder")


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Captures:
    """One Mac worker; SQLite commits queue/state before HTTP acknowledgement."""

    def __init__(self, data, pipeline, processor=process_capture):
        self.data = Path(data).resolve()
        self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.jobs = self.data / "jobs"
        self.jobs.mkdir(mode=0o700, exist_ok=True)
        self.lock_file = (self.data / "worker.lock").open("a")
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self.lock_file.close()
            raise ValueError("Another recorder already owns this data directory.") from exc
        self.staging = self.data / "upload-staging"
        self.staging.mkdir(mode=0o700, exist_ok=True)
        # The lock rules out another writer, so partial network transfers from the
        # previous process can be reclaimed without touching acknowledged inputs.
        for pending in self.staging.glob("body-*"):
            pending.unlink()
        key_file = self.data / "organizer.key"
        if not key_file.exists():
            with os.fdopen(os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
                f.write(secrets.token_urlsafe(32) + "\n")
        self.key = key_file.read_text().strip()
        if not re.fullmatch(r"[a-zA-Z0-9_-]{32,128}", self.key):
            raise ValueError("Invalid organizer.key; restore the recorder's private key.")
        self.pipeline = Path(pipeline).resolve()
        self.processor = processor
        self.changed = threading.Condition()
        self.stopping = False
        self.uploads = threading.BoundedSemaphore(4)
        self.db = sqlite3.connect(self.data / "captures.sqlite", check_same_thread=False,
                                  isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("""CREATE TABLE IF NOT EXISTS captures (
            id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'uploading',
            video TEXT, motion TEXT, motion_summary TEXT, stage TEXT, error TEXT,
            asset TEXT, share TEXT UNIQUE)""")
        self.native = self.data / "native-models"
        self.native.mkdir(mode=0o700, exist_ok=True)
        self.db.execute("CREATE TABLE IF NOT EXISTS native_scans (id TEXT PRIMARY KEY, digest TEXT NOT NULL, share TEXT UNIQUE NOT NULL)")
        # A solver interrupted by a reboot gets a fresh attempt, using the same inputs.
        self.db.execute("UPDATE captures SET status='queued', stage='Waiting to resume' WHERE status='processing'")
        self.thread = threading.Thread(target=self._work, name="reconstruction", daemon=True)
        self.thread.start()

    def close(self):
        with self.changed:
            self.stopping = True
            self.changed.notify()
        self.thread.join()
        self.db.close()
        self.lock_file.close()

    def _row(self, capture_id):
        return self.db.execute("SELECT * FROM captures WHERE id=?", (capture_id,)).fetchone()

    @staticmethod
    def _status(row):
        result = {"status": row["status"]}
        for key in ("stage", "error"):
            if row[key]:
                result[key] = row[key]
        if row["motion_summary"]:
            result["motionSummary"] = json.loads(row["motion_summary"])
        if row["status"] == "ready":
            result["sharePath"] = "/s/" + row["share"]
        return result

    def status(self, capture_id):
        with self.changed:
            row = self._row(capture_id)
            if not row:
                raise RequestError(404, "Capture not found.")
            return self._status(row)

    def store(self, capture_id, kind, upload, digest, summary):
        name = "input.video" if kind == "video" else "motion.json"
        with self.changed:
            row = self._row(capture_id)
            if row and row[kind]:
                if row[kind] != digest:
                    raise RequestError(409, "This recording already has different data. Start a new recording.")
                return self._status(row)
            if row and row["status"] != "uploading":
                raise RequestError(409, "This recording has already been submitted.")
            job = self.jobs / capture_id
            job.mkdir(mode=0o700, exist_ok=True)
            # Promote input bytes before marking them available. A retry after a crash
            # can replace an unacknowledged file; committed parts are immutable.
            os.replace(upload, job / name)
            self.db.execute("INSERT OR IGNORE INTO captures(id) VALUES(?)", (capture_id,))
            if kind == "video":
                self.db.execute("UPDATE captures SET video=? WHERE id=?", (digest, capture_id))
            else:
                self.db.execute("UPDATE captures SET motion=?,motion_summary=? WHERE id=?",
                                (digest, json.dumps(summary, allow_nan=False), capture_id))
            return self._status(self._row(capture_id))

    def submit(self, capture_id):
        with self.changed:
            row = self._row(capture_id)
            if not row or not row["video"] or not row["motion"]:
                raise RequestError(409, "Upload the recording and motion file first.")
            if row["status"] in ("uploading", "failed"):
                pending = self.db.execute("SELECT COUNT(*) FROM captures WHERE status IN ('queued','processing')").fetchone()[0]
                if pending >= 8:
                    raise RequestError(429, "The Mac queue is full. Try again when a scan finishes.")
                self.db.execute("UPDATE captures SET status='queued', stage='Waiting for the Mac', error=NULL WHERE id=?",
                                (capture_id,))
                self.changed.notify()
            return self._status(self._row(capture_id))

    def publish_native(self, capture_id, upload, digest):
        try:
            validate_native_model(upload)
        except (ValueError, KeyError, TypeError, IndexError, AttributeError, OverflowError, RecursionError) as exc:
            raise RequestError(400, "Expected a self-contained native scan GLB.") from exc
        with self.changed:
            row = self.db.execute("SELECT digest,share FROM native_scans WHERE id=?", (capture_id,)).fetchone()
            if row and row['digest'] != digest:
                raise RequestError(409, "A different model is already published for this scan.")
            token = row['share'] if row else secrets.token_hex(16)
            target = self.native / (capture_id + '.glb')
            if not row or not target.is_file():
                os.replace(upload, target)
            if not row:
                self.db.execute("INSERT INTO native_scans(id,digest,share) VALUES(?,?,?)", (capture_id,digest,token))
            return {"status": "ready", "sharePath": "/s/" + token}

    def shared_asset(self, share_id):
        with self.changed:
            row = self.db.execute("SELECT id,asset FROM captures WHERE share=? AND status='ready'", (share_id,)).fetchone()
            native = None if row else self.db.execute("SELECT id FROM native_scans WHERE share=?",(share_id,)).fetchone()
        if row:
            path = self.jobs / row["id"] / row["asset"]
        elif native:
            path = self.native / (native['id'] + '.glb')
        else:
            raise RequestError(404, "Scan not found.")
        if not path.is_file():
            raise RequestError(404, "Scan file unavailable on this Mac.")
        return path

    def _work(self):
        while True:
            with self.changed:
                while True:
                    if self.stopping:
                        return
                    row = self.db.execute("SELECT id FROM captures WHERE status='queued' ORDER BY rowid LIMIT 1").fetchone()
                    if row:
                        break
                    self.changed.wait()
                capture_id = row["id"]
                summary = json.loads(self._row(capture_id)["motion_summary"])
                self.db.execute("UPDATE captures SET status='processing', stage='Starting reconstruction' WHERE id=?",
                                (capture_id,))
            job = self.jobs / capture_id

            def progress(stage):
                with self.changed:
                    self.db.execute("UPDATE captures SET stage=? WHERE id=?", (stage, capture_id))

            try:
                asset = Path(self.processor(job, self.pipeline, progress)).resolve()
                if not asset.is_relative_to(job) or asset.suffix.lower() != ".glb":
                    raise ValueError("Invalid worker output path.")
                check_glb(asset)
                relative = str(asset.relative_to(job))
                report = job / "motion-summary.json"
                if report.is_file():
                    measured = json.loads(report.read_text())
                    summary["samplingReason"] = measured.get("samplingReason")
                    for trial in measured.get("trials", []):
                        if trial.get("run") == measured.get("selectedRun"):
                            for key in ("sampledFrames", "registeredFrames", "supportedFraction", "missingIntervalsSeconds"):
                                if key in trial:
                                    summary[key] = trial[key]
                            break
                with self.changed:
                    self.db.execute("""UPDATE captures SET status='ready', stage='Ready to view', asset=?, share=?, motion_summary=?
                        WHERE id=?""", (relative, secrets.token_hex(16), json.dumps(summary, allow_nan=False), capture_id))
            except Exception as exc:
                LOG.exception("Reconstruction failed for %s", capture_id)
                message = str(exc) if isinstance(exc, CaptureError) else "Reconstruction failed. Check the Mac worker log and retry."
                with self.changed:
                    self.db.execute("UPDATE captures SET status='failed', stage=NULL, error=? WHERE id=?",
                                    (message, capture_id))


class RecorderHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(75)
        # Safari may preconnect before recording starts. A slow TLS handshake must
        # only occupy that connection's worker, leaving the accept loop available.
        tls = getattr(self.server, "tls", None)
        if tls:
            self.request = tls.wrap_socket(self.request, server_side=True)
        super().setup()

    def log_request(self, code="-", size="-"):
        # Default access logs contain transferable guest share tokens.
        pass

    def headers_for(self, status, content_type, length):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()

    def json_reply(self, value, status=200):
        data = json.dumps(value, allow_nan=False).encode()
        self.headers_for(status, "application/json; charset=utf-8", len(data))
        if self.command != "HEAD":
            self.wfile.write(data)

    def file_reply(self, path, content_type):
        with path.open("rb") as f:
            self.headers_for(200, content_type, os.fstat(f.fileno()).st_size)
            if self.command != "HEAD":
                shutil.copyfileobj(f, self.wfile, 128 * 1024)

    def require_organizer(self):
        supplied = self.headers.get("Authorization", "").encode("utf-8")
        expected = ("Bearer " + self.server.captures.key).encode("ascii")
        if not hmac.compare_digest(supplied, expected):
            raise RequestError(401, "Open the organizer link from your Mac to record.")

    def length(self, maximum):
        if "Transfer-Encoding" in self.headers:
            raise RequestError(411, "Send a recording with a known byte length.")
        values = self.headers.get_all("Content-Length") or []
        if not values and self.command == "POST":
            return 0
        if len(values) != 1 or not re.fullmatch(r"[0-9]{1,18}", values[0]):
            raise RequestError(411, "A valid Content-Length is required.")
        length = int(values[0])
        if length > maximum:
            raise RequestError(413, "Upload exceeds the recorder size limit.")
        return length

    def receive(self, capture_id, kind):
        media = self.headers.get_content_type()
        allowed = ("video/mp4", "video/quicktime", "video/webm", "application/octet-stream")
        if (kind == "model" and media != "model/gltf-binary") or (kind == "motion" and media != "application/json") or (kind == "video" and media not in allowed):
            raise RequestError(415, "Unsupported recording content type.")
        size = self.length({"model": 64 * 1024 * 1024, "video": VIDEO_LIMIT, "motion": MOTION_LIMIT}[kind])
        if not size:
            raise RequestError(400, "Empty upload.")
        captures = self.server.captures
        if not captures.uploads.acquire(blocking=False):
            raise RequestError(429, "Other uploads are in progress. Try again.")
        try:
            with tempfile.NamedTemporaryFile(prefix="body-", dir=captures.staging, delete=False) as f:
                path = Path(f.name)
            try:
                digest = hashlib.sha256()
                with path.open("wb") as f:
                    remaining = size
                    while remaining:
                        part = self.rfile.read(min(128 * 1024, remaining))
                        if not part:
                            raise RequestError(400, "Incomplete upload.")
                        f.write(part)
                        digest.update(part)
                        remaining -= len(part)
                    f.flush()
                    os.fsync(f.fileno())
                if kind == "model":
                    return captures.publish_native(capture_id, path, digest.hexdigest())
                summary = None
                if kind == "video":
                    with path.open("rb") as f:
                        head = f.read(16)
                    if len(head) < 12 or not (head.startswith(b"\x1a\x45\xdf\xa3") or
                            head[4:8] in (b"ftyp", b"moov", b"mdat", b"free", b"wide", b"skip")):
                        raise RequestError(400, "Expected an MP4, MOV or WebM recording.")
                else:
                    try:
                        summary = validate_motion(json.loads(path.read_bytes()))
                    except (ValueError, RecursionError) as exc:
                        raise RequestError(400, "Invalid motion file: " + str(exc)[:180]) from exc
                return captures.store(capture_id, kind, path, digest.hexdigest(), summary)
            finally:
                path.unlink(missing_ok=True)
        finally:
            captures.uploads.release()

    def route(self):
        path = urlsplit(self.path).path
        read = self.command in ("GET", "HEAD")
        captures = self.server.captures
        native = re.fullmatch(rf"/api/native-scans/({UUID})", path)
        if native and self.command == "PUT":
            self.require_organizer()
            return self.json_reply(self.receive(native.group(1), "model"))
        if path.startswith("/api/captures/"):
            self.require_organizer()
            match = re.fullmatch(rf"/api/captures/({UUID})(?:/(video|motion|process))?", path)
            if match:
                capture_id, kind = match.groups()
                if self.command == "PUT" and kind in ("video", "motion"):
                    return self.json_reply(self.receive(capture_id, kind))
                if self.command == "POST" and kind == "process":
                    self.length(0)
                    result = captures.submit(capture_id)
                    return self.json_reply(result, 200 if result["status"] == "ready" else 202)
                if read and kind is None:
                    return self.json_reply(captures.status(capture_id))
        if read:
            share = re.fullmatch(rf"/api/shares/({SHARE})(/asset)?", path)
            if share:
                token, wants_bytes = share.groups()
                asset = captures.shared_asset(token)
                if wants_bytes:
                    return self.file_reply(asset, "model/gltf-binary")
                return self.json_reply({"shareId": token, "format": "glb", "assetPath": f"/api/shares/{token}/asset"})
            guest = re.fullmatch(rf"/s/({SHARE})/?", path)
            if guest:
                captures.shared_asset(guest.group(1))
            if path == "/":
                self.send_response(302)
                self.send_header("Location", "/record")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if path in ("/record", "/record/") or guest:
                return self.file_reply(self.server.dist / "index.html", "text/html; charset=utf-8")
            # Only Vite's built assets are addressable, including when a path is guessed.
            if re.fullmatch(r"/assets/[A-Za-z0-9._/-]+", path):
                target = (self.server.dist / path[1:]).resolve()
                if target.is_relative_to(self.server.dist / "assets") and target.is_file():
                    mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                    return self.file_reply(target, mime)
        raise RequestError(404, "Not found.")

    def dispatch(self):
        try:
            self.route()
        except RequestError as error:
            self.json_reply({"error": str(error)}, error.status)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            LOG.exception("Handling %s request failed", self.command)
            self.json_reply({"error": "The Mac could not complete this request."}, 500)

    do_GET = do_HEAD = do_PUT = do_POST = dispatch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--dist", required=True, type=Path)
    parser.add_argument("--pipeline", required=True, type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8799, type=int)
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    args = parser.parse_args()
    if bool(args.cert) != bool(args.key):
        parser.error("Provide both --cert and --key for HTTPS.")
    if not args.cert and args.host not in ("localhost", "127.0.0.1"):
        parser.error("Use HTTPS when listening on the network, or use a loopback HTTPS proxy.")
    dist = args.dist.resolve()
    if not (dist / "index.html").is_file() or not args.pipeline.is_file() or not os.access(args.pipeline, os.X_OK):
        parser.error("Provide a built website and the executable hallway3d pipeline.")
    if args.data.resolve().is_relative_to(dist) or dist.is_relative_to(args.data.resolve()):
        parser.error("Keep private capture storage separate from the web distribution.")
    os.umask(0o077)
    with ThreadingHTTPServer((args.host, args.port), RecorderHandler) as server:
        if args.cert:
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.minimum_version = ssl.TLSVersion.TLSv1_2
            tls.load_cert_chain(args.cert, args.key)
            server.tls = tls
        server.daemon_threads = False
        server.dist = dist
        captures = server.captures = Captures(args.data, args.pipeline)
        print(f"Path recorder listening on {args.host}:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            captures.close()


if __name__ == "__main__":
    main()
