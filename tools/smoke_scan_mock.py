#!/usr/bin/env python3
"""Exercise scan formats, access changes, and upload failures on a local port."""

import argparse
import json
import struct
import threading
from http.client import HTTPConnection
from pathlib import Path
from tempfile import TemporaryDirectory

from scan_mock import MAX_UPLOAD_BYTES, ScanServer

OWNER = {"X-Dev-User": "demo-owner"}
GUEST = {"X-Dev-User": "demo-guest"}
VISITOR = {"X-Dev-User": "other-visitor"}


def request(server, method, path, body=None, headers=None):
    conn = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, response.headers, response.read()
    finally:
        conn.close()


def change_access(server, share, visibility, viewers, user=OWNER):
    body = json.dumps({"visibility": visibility, "viewerIds": viewers}).encode()
    return request(server, "PATCH", "/api/scans/" + share["shareId"], body,
                   {"Content-Type": "application/json", **user})[0]


def check_access(server, share, user, expected_status):
    metadata = "/api/shares/" + share["shareId"]
    for path in (share["sharePath"], metadata, metadata + "/asset"):
        status, headers, _ = request(server, "GET", path, headers=user)
        assert status == expected_status, (path, status, expected_status)
        assert headers["Cache-Control"] == "no-store"


def listed(server):
    status, _, data = request(server, "GET", "/api/scans/public")
    assert status == 200
    return json.loads(data)["scans"]


def run(server, ply):
    gltf = b'{"asset":{"version":"2.0"}}'.ljust(28, b" ")
    glb = struct.pack("<4sIII4s", b"glTF", 2, 20 + len(gltf), len(gltf), b"JSON") + gltf
    models = [("ply", ply, "application/octet-stream"), ("glb", glb, "model/gltf-binary")]
    shares = []
    for (file_format, data, media_type), visibility in zip(models, ("", "&visibility=unlisted")):
        status, _, body = request(server, "POST", f"/api/scans?format={file_format}{visibility}",
                                  data, {"Content-Type": media_type, **OWNER})
        assert status == 201, (status, body)
        shares.append(json.loads(body))
    assert shares[0]["shareId"] != shares[1]["shareId"]

    for share, (file_format, data, _) in zip(shares, models):
        share_id = share["shareId"]
        asset = f"/api/shares/{share_id}/asset"
        assert share["sharePath"] == f"/s/{share_id}"
        status, _, body = request(server, "GET", share["sharePath"], headers=OWNER)
        assert status == 200 and asset.encode() in body
        status, _, body = request(server, "GET", f"/api/shares/{share_id}", headers=OWNER)
        assert status == 200 and json.loads(body) == {
            "shareId": share_id, "format": file_format, "assetPath": asset
        }
        status, headers, body = request(server, "GET", asset, headers=OWNER)
        assert status == 200 and body == data
        assert headers["Content-Disposition"] == f'attachment; filename="scan.{file_format}"'
        assert headers["X-Content-Type-Options"] == "nosniff"

    endpoint = "/api/scans?format=ply"
    binary = {"Content-Type": "application/octet-stream", **OWNER}
    assert request(server, "POST", endpoint, ply, {"Content-Type": "application/octet-stream"})[0] == 401
    status, _, body = request(server, "POST", endpoint + "&visibility=public", ply, binary)
    public = json.loads(body)
    assert status == 201 and listed(server) == [public]
    private, unlisted = shares
    check_access(server, public, {}, 200)
    check_access(server, unlisted, {}, 200)
    check_access(server, private, {}, 404)
    check_access(server, private, VISITOR, 404)
    assert change_access(server, private, "private", ["demo-guest"]) == 200
    check_access(server, private, GUEST, 200)
    assert change_access(server, private, "public", [], GUEST) == 404
    assert change_access(server, private, "private", []) == 200
    check_access(server, private, GUEST, 404)
    assert change_access(server, public, "private", []) == 200
    assert listed(server) == []
    check_access(server, public, {}, 404)
    check_access(server, public, OWNER, 200)
    assert request(server, "GET", "/api/shares/" + "0" * 32)[0] == 404
    assert request(server, "POST", "/api/scans?format=txt", ply, binary)[0] == 400
    assert request(server, "POST", endpoint, b"bad data", binary)[0] == 400
    assert request(server, "POST", endpoint, ply, {"Content-Type": "text/plain", **OWNER})[0] == 415
    assert request(server, "POST", endpoint, b"", {**binary, "Content-Length": str(MAX_UPLOAD_BYTES + 1)})[0] == 413


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path, nargs="?",
                        default=Path(__file__).resolve().parents[1] / "fixtures/venue/scene.ply")
    args = parser.parse_args()
    with TemporaryDirectory() as directory, ScanServer(0, directory) as server:
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            run(server, args.fixture.read_bytes())
        finally:
            server.shutdown()
            thread.join()
    print("Verified scan bytes, all three visibility modes, grants, revocation, and upload failures.")


if __name__ == "__main__":
    main()
