"""The internal HTTP service, exercised over a real local socket (no Gemini calls)."""

import base64
import json
import logging
import threading
from http.client import HTTPConnection

import pytest

from conftest import FAKE_KEY, JPEG, PNG, SECRET_BYTES, assert_clean, candidate, make_service, request_dict, response_json

from path_gemini import ConfigurationError, GeminiRateLimitedError
from path_gemini.server import MAX_BODY_BYTES, make_server

TOKEN = "service-token-for-tests-0123456789"


@pytest.fixture
def server_for():
    servers = []

    def start(script):
        service, _ = make_service(script)
        srv = make_server("127.0.0.1", 0, TOKEN, lambda: service)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        servers.append(srv)
        return srv, service

    yield start
    for srv in servers:
        srv.shutdown()
        srv.server_close()


def call(srv, method, path, body=None, token=TOKEN, content_type="application/json", raw=None):
    conn = HTTPConnection("127.0.0.1", srv.server_port, timeout=10)
    headers = {}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    if data is not None:
        headers["Content-Type"] = content_type
    try:
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        return resp.status, json.loads(resp.read() or b"{}")
    finally:
        conn.close()


def landmark_body(**overrides):
    d = request_dict(**overrides)
    for f in d["frames"]:
        f["imageBase64"] = base64.b64encode(f.pop("imageBytes")).decode()
    return d


def test_healthz_needs_no_token_and_shows_no_secrets(server_for):
    srv, _ = server_for([])
    status, body = call(srv, "GET", "/healthz", token=None)
    assert status == 200 and body == {"ok": True, "promptVersion": "landmark-v2", "model": "test-model"}
    assert FAKE_KEY not in json.dumps(body)


@pytest.mark.parametrize("token", [None, "", "wrong-token-wrong-token-wrong", TOKEN + "x"])
def test_wrong_or_missing_token_is_401(server_for, token):
    srv, service = server_for([response_json()])
    status, body = call(srv, "POST", "/v1/landmarks", landmark_body(), token=token)
    assert status == 401 and body["error"]["code"] == "UNAUTHORIZED" and service.client.calls == 0


def test_landmarks_success(server_for):
    srv, service = server_for([response_json()])
    status, body = call(srv, "POST", "/v1/landmarks", landmark_body())
    assert status == 200 and body["category"] == "CANDIDATES"
    assert body["candidates"][0]["landmarkType"] == "artwork" and body["promptVersion"] == "landmark-v2"
    assert body["frameIds"] == ["frame-000138", "frame-000142", "frame-000150"]
    sent = [p.data for p in service.client.prompts[0].parts if p.kind == "image"]
    assert sent == [SECRET_BYTES, JPEG, PNG]  # base64 decoded back to the exact bytes
    assert "imageBase64" not in json.dumps(body) and "imageBytes" not in json.dumps(body)


def test_landmarks_without_waypoints_for_navmesh_corners(server_for):
    srv, service = server_for([response_json()])
    body = landmark_body()
    del body["waypoints"]
    status, out = call(srv, "POST", "/v1/landmarks", body)
    assert status == 200
    assert "corner on the computed walking path" in service.client.prompts[0].parts[0].text


def test_stairs_with_side(server_for):
    reply = response_json([candidate(instruction="Turn left and take the stairs down by the C4 sign.",
                                     landmark="C4 stair sign", landmarkType="sign")])
    srv, _ = server_for([reply])
    status, out = call(srv, "POST", "/v1/landmarks",
                       landmark_body(verifiedMovement={"maneuver": "stairs_down", "side": "left"}))
    assert status == 200 and out["side"] == "left" and out["maneuver"] == "stairs_down"


def test_abstention_is_200(server_for):
    srv, _ = server_for([response_json([], abstained=True, reason="Plain walls only.")])
    status, body = call(srv, "POST", "/v1/landmarks", landmark_body())
    assert status == 200 and body["category"] == "NO_CLEAR_LANDMARK"


@pytest.mark.parametrize("script,status,code", [
    ([GeminiRateLimitedError()] * 3, 503, "GEMINI_RATE_LIMITED"),
    ([response_json([candidate(instruction="Turn right at the mural.")])], 502, "CONFLICTING_DIRECTION"),
    (["not json"], 502, "INVALID_MODEL_OUTPUT"),
])
def test_provider_and_output_failures_map_to_status(server_for, script, status, code):
    srv, _ = server_for(script)
    got, body = call(srv, "POST", "/v1/landmarks", landmark_body())
    assert got == status and body["error"]["code"] == code
    assert_clean(json.dumps(body))


@pytest.mark.parametrize("mutate,code,status", [
    (lambda b: b["frames"][0].update(imageBase64="***not base64***"), "INVALID_REQUEST", 400),
    (lambda b: b["frames"][0].pop("imageBase64"), "INVALID_REQUEST", 400),
    (lambda b: b["frames"][0].update(mimeType="image/gif"), "UNSUPPORTED_MEDIA", 415),
    (lambda b: b["frames"][0].update(imageBase64=base64.b64encode(b"junk").decode()), "CORRUPT_IMAGE", 400),
    (lambda b: b.update(frames=b["frames"][:1]), "INVALID_REQUEST", 400),
    (lambda b: b["verifiedMovement"].update(maneuver="sideways"), "INVALID_REQUEST", 400),
    (lambda b: b["verifiedMovement"].update(side="left"), "INVALID_REQUEST", 400),  # side on a plain left
    (lambda b: b["frames"][0].update(imageUrl="https://example.com/x.jpg"), "INVALID_REQUEST", 400),
])
def test_bad_landmark_requests(server_for, mutate, code, status):
    srv, service = server_for([response_json()])
    body = landmark_body()
    mutate(body)
    got, out = call(srv, "POST", "/v1/landmarks", body)
    assert got == status and out["error"]["code"] == code and service.client.calls == 0
    assert_clean(json.dumps(out)) and "sideways" not in json.dumps(out)


def test_turns_endpoint(server_for):
    srv, _ = server_for([])
    status, body = call(srv, "POST", "/v1/turns",
                        {"points": [{"x": 0, "y": 0, "z": 0}, {"x": 0, "y": 0, "z": -4}, {"x": -3, "y": 0, "z": -4}]})
    assert status == 200 and [t["maneuver"] for t in body["turns"]] == ["left", "arrive"]
    assert body["turns"][0]["instruction"] == "Turn left"
    status, body = call(srv, "POST", "/v1/turns", {"points": [[0, 0, 0]]})
    assert status == 400 and body["error"]["code"] == "INVALID_PATH"


def test_frames_select_endpoint(server_for):
    from test_photo_select import TURN, walk_left_turn
    srv, _ = server_for([])
    status, body = call(srv, "POST", "/v1/frames/select", {"turn": TURN, "frames": walk_left_turn()})
    assert status == 200 and (body["approach"], body["junction"], body["exit"]) == ("a3", "a7", "b2")
    status, body = call(srv, "POST", "/v1/frames/select", {"turn": {}, "frames": []})
    assert status == 400


def test_transport_errors(server_for):
    srv, _ = server_for([])
    assert call(srv, "POST", "/v1/nope", {})[0] == 404
    assert call(srv, "GET", "/v1/turns", token=None)[0] == 404
    assert call(srv, "POST", "/v1/turns", raw=b"{oops")[1]["error"]["code"] == "INVALID_REQUEST"
    assert call(srv, "POST", "/v1/turns", raw=b"[1,2]")[0] == 400
    assert call(srv, "POST", "/v1/turns", {"points": []}, content_type="text/plain")[0] == 415


def test_oversized_body_rejected_before_reading(server_for):
    srv, _ = server_for([])
    conn = HTTPConnection("127.0.0.1", srv.server_port, timeout=10)
    conn.putrequest("POST", "/v1/landmarks")
    conn.putheader("Authorization", "Bearer " + TOKEN)
    conn.putheader("Content-Type", "application/json")
    conn.putheader("Content-Length", str(MAX_BODY_BYTES + 1))
    conn.endheaders()
    resp = conn.getresponse()
    assert resp.status == 413
    conn.close()


def test_logs_have_no_bodies_or_secrets(server_for, caplog):
    caplog.set_level(logging.INFO, logger="path_gemini")
    srv, _ = server_for([response_json()])
    call(srv, "POST", "/v1/landmarks", landmark_body())
    assert "POST /v1/landmarks 200" in caplog.text
    assert_clean(caplog.text)
    assert TOKEN not in caplog.text and "Turn left" not in caplog.text


def test_short_token_refused():
    service, _ = make_service([])
    with pytest.raises(ConfigurationError):
        make_server("127.0.0.1", 0, "short", lambda: service)
