"""Small internal HTTP service so Sam's TypeScript backend can use this package.

Run it next to the backend (same Docker network or same machine). It is not
for browsers or the public internet. Every endpoint except ``/healthz``
needs ``Authorization: Bearer <GEMINI_SERVICE_TOKEN>``.

    GET  /healthz              liveness + model + prompt version (no secrets)
    POST /v1/turns             path corner points -> turn-by-turn list
    POST /v1/frames/select     one turn + frames.json entries -> best photo IDs
    POST /v1/landmarks         verified turn + 2-3 photos (base64) -> drafts

Errors use Sam's envelope: ``{"error": {"code", "message", "details"}}``.
Request bodies, photos, prompts and keys are never logged.

Environment:
    GEMINI_SERVICE_TOKEN   required, at least 24 characters (shared with Sam's backend)
    GEMINI_SERVICE_HOST    default 127.0.0.1 (use 0.0.0.0 only inside a private Docker network)
    GEMINI_SERVICE_PORT    default 8090
    plus the GEMINI_* settings in config.py

Run: ``python -m path_gemini.server``
"""

import base64
import binascii
import hmac
import json
import logging
import os
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional, Tuple

from pydantic import ValidationError

from .config import GeminiConfig
from .errors import ConfigurationError, ErrorCode, LandmarkError
from .models import LandmarkRequest
from .photo_select import FrameSelectError, select_frames
from .prompt import PROMPT_VERSION
from .service import LandmarkService
from .turns import PathError, path_turns

log = logging.getLogger("path_gemini.server")

MAX_BODY_BYTES = 24 * 1024 * 1024  # three 5 MiB photos as base64, plus JSON
MIN_TOKEN_CHARS = 24

STATUS_FOR = {
    ErrorCode.INVALID_REQUEST: 400,
    ErrorCode.UNSUPPORTED_MEDIA: 415,
    ErrorCode.CORRUPT_IMAGE: 400,
    ErrorCode.CONFIGURATION_INVALID: 500,
    ErrorCode.GEMINI_AUTHENTICATION_FAILED: 502,
    ErrorCode.GEMINI_RATE_LIMITED: 503,
    ErrorCode.GEMINI_UNAVAILABLE: 503,
    ErrorCode.GEMINI_TIMEOUT: 504,
    ErrorCode.GEMINI_SAFETY_BLOCK: 422,
    ErrorCode.INVALID_MODEL_OUTPUT: 502,
    ErrorCode.CONFLICTING_DIRECTION: 502,
}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details=()):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, list(details)


def decode_landmark_request(body: dict) -> LandmarkRequest:
    """JSON body -> LandmarkRequest. Photos arrive as ``frames[i].imageBase64``."""
    if not isinstance(body, dict) or not isinstance(body.get("frames"), list):
        raise ApiError(400, "INVALID_REQUEST", "Body must be a landmark request with a frames list.")
    frames = []
    for i, frame in enumerate(body["frames"]):
        if not isinstance(frame, dict):
            raise ApiError(400, "INVALID_REQUEST", "Each frame must be an object.", ["frames[{}]".format(i)])
        frame = dict(frame)
        encoded = frame.pop("imageBase64", None)
        if not isinstance(encoded, str) or not encoded:
            raise ApiError(400, "INVALID_REQUEST", "Each frame needs imageBase64.", ["frames[{}]".format(i)])
        try:
            frame["imageBytes"] = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            raise ApiError(400, "INVALID_REQUEST", "imageBase64 is not valid base64.",
                           ["frames[{}]".format(i)]) from None
        frames.append(frame)
    data = dict(body, frames=frames)
    try:
        return LandmarkRequest.model_validate(data)
    except ValidationError as exc:
        locs = sorted({".".join(str(p) for p in e["loc"]) for e in exc.errors()})
        raise ApiError(400, "INVALID_REQUEST", "The landmark request is invalid.", locs[:10]) from None


class Handler(BaseHTTPRequestHandler):
    server_version = "path-gemini"
    sys_version = ""
    service_factory: Callable[[], LandmarkService]
    token: str
    _service: Optional[LandmarkService] = None

    # ------------------------------------------------------------ plumbing --

    def log_message(self, fmt, *args):  # replace default access log (it can include paths only)
        return

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, err: ApiError) -> None:
        self._send(err.status, {"error": {"code": err.code, "message": err.message, "details": err.details}})

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        supplied = header[7:] if header.startswith("Bearer ") else ""
        return hmac.compare_digest(supplied.encode("utf-8"), self.token.encode("utf-8"))

    def _read_json(self) -> dict:
        if (self.headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
            raise ApiError(415, "UNSUPPORTED_MEDIA", "Send Content-Type: application/json.")
        try:
            length = int(self.headers.get("Content-Length") or "")
        except ValueError:
            raise ApiError(411, "INVALID_REQUEST", "Content-Length is required.") from None
        if length < 0 or length > MAX_BODY_BYTES:
            raise ApiError(413, "INVALID_REQUEST", "Body is larger than {} bytes.".format(MAX_BODY_BYTES))
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "INVALID_REQUEST", "Body is not valid JSON.") from None
        if not isinstance(data, dict):
            raise ApiError(400, "INVALID_REQUEST", "Body must be a JSON object.")
        return data

    def _landmark_service(self) -> LandmarkService:
        cls = type(self)
        if cls._service is None:
            cls._service = cls.service_factory()
        return cls._service

    def _finish(self, started: float, route: str, status: int) -> None:
        log.info("%s %s %d %dms", self.command, route, status, int((time.monotonic() - started) * 1000))

    # -------------------------------------------------------------- routes --

    def do_GET(self):
        started = time.monotonic()
        if self.path.split("?")[0] != "/healthz":
            self._error(ApiError(404, "NOT_FOUND", "Unknown endpoint."))
            return self._finish(started, "unknown", 404)
        try:
            model = self._landmark_service().config.model
        except LandmarkError:
            model = None
        self._send(200, {"ok": True, "promptVersion": PROMPT_VERSION, "model": model})
        self._finish(started, "/healthz", 200)

    def do_POST(self):
        started = time.monotonic()
        route = self.path.split("?")[0]
        handlers = {
            "/v1/turns": self._turns,
            "/v1/frames/select": self._select,
            "/v1/landmarks": self._landmarks,
        }
        status = 500
        try:
            if route not in handlers:
                raise ApiError(404, "NOT_FOUND", "Unknown endpoint.")
            if not self._authorized():
                raise ApiError(401, "UNAUTHORIZED", "Missing or wrong service token.")
            status, payload = handlers[route](self._read_json())
            self._send(status, payload)
        except ApiError as err:
            status = err.status
            self._error(err)
        except LandmarkError as err:
            status = STATUS_FOR.get(err.code, 500)
            self._send(status, {"error": err.to_dict()})
        except Exception:  # noqa: BLE001 - never leak internals
            status = 500
            log.exception("unexpected error on %s", route)
            self._error(ApiError(500, "INTERNAL", "Unexpected error."))
        self._finish(started, route if route in handlers else "unknown", status)

    def _turns(self, body: dict) -> Tuple[int, dict]:
        try:
            turns = path_turns(body.get("points"), include_straight=bool(body.get("includeStraight", False)))
        except PathError as err:
            raise ApiError(400, "INVALID_PATH", str(err)) from None
        return 200, {"turns": [t.to_dict() for t in turns]}

    def _select(self, body: dict) -> Tuple[int, dict]:
        frames = body.get("frames")
        if not isinstance(frames, list) or len(frames) > 5000:
            raise ApiError(400, "INVALID_REQUEST", "frames must be a list of at most 5000 frames.json entries.")
        try:
            return 200, select_frames(body.get("turn"), frames, body.get("captureToSpace"))
        except FrameSelectError as err:
            raise ApiError(400, "INVALID_REQUEST", str(err)) from None

    def _landmarks(self, body: dict) -> Tuple[int, dict]:
        request = decode_landmark_request(body)
        result = self._landmark_service().propose_landmarks(request)
        return 200, result.model_dump(mode="json", by_alias=True)


def make_server(host: str, port: int, token: str,
                service_factory: Callable[[], LandmarkService]) -> ThreadingHTTPServer:
    if not token or len(token) < MIN_TOKEN_CHARS:
        raise ConfigurationError("GEMINI_SERVICE_TOKEN must be at least {} characters.".format(MIN_TOKEN_CHARS))
    handler = type("BoundHandler", (Handler,), {
        "service_factory": staticmethod(service_factory), "token": token, "_service": None})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    host = os.environ.get("GEMINI_SERVICE_HOST", "127.0.0.1")
    try:
        port = int(os.environ.get("GEMINI_SERVICE_PORT", "8090"))
        config = GeminiConfig.from_env()  # fail at start-up, not on the first request
        server = make_server(host, port, os.environ.get("GEMINI_SERVICE_TOKEN", ""),
                             lambda: LandmarkService(config))
    except (ConfigurationError, ValueError) as err:
        print("error: {}".format(err), file=sys.stderr)
        return 1
    log.info("path-gemini service on http://%s:%d (model %s, prompt %s)", host, port, config.model, PROMPT_VERSION)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
