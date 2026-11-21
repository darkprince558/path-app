#!/usr/bin/env python3
"""Exercise scan formats, access changes, map management, and upload failures on a local port."""

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


def listed(server, path="/api/scans/public", user=None):
    status, _, data = request(server, "GET", path, headers=user)
    assert status == 200, (path, status)
    return json.loads(data)["scans"]


def ids(scans):
    return [scan["shareId"] for scan in scans]


def patch(server, share, change, user=OWNER):
    status, _, body = request(server, "PATCH", "/api/scans/" + share["shareId"], json.dumps(change).encode(),
                              {"Content-Type": "application/json", **user})
    return status, (json.loads(body) if body else None)


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
            "shareId": share_id, "format": file_format, "assetPath": asset, "name": "Untitled map"
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
    assert status == 201 and ids(listed(server)) == [public["shareId"]]
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
    manage(server, ply, binary)


def manage(server, ply, binary):
    """Names, the owner's and viewer's lists, partial changes, renaming and deleting."""
    status, _, body = request(server, "POST", "/api/scans?format=ply&visibility=private&name=%20Library%20%20rooms%20",
                              ply, binary)
    library = json.loads(body)
    assert status == 201 and library["name"] == "Library rooms", body
    for bad in ("", "%20%20", "a" * 81, "bell%07name"):
        assert request(server, "POST", f"/api/scans?format=ply&name={bad}", ply, binary)[0] == 400, bad

    mine = listed(server, "/api/scans/mine", OWNER)
    assert mine[0]["shareId"] == library["shareId"], "newest first"
    assert set(mine[0]) == {"shareId", "sharePath", "name", "format", "visibility", "updatedAt", "viewerIds"}
    assert mine[0]["visibility"] == "private" and mine[0]["viewerIds"] == []
    assert listed(server, "/api/scans/mine", GUEST) == []
    assert request(server, "GET", "/api/scans/mine")[0] == 401
    assert request(server, "GET", "/api/scans/shared")[0] == 401

    # A partial change keeps the other fields; viewerIds still replaces the whole list.
    assert patch(server, library, {"viewerIds": ["demo-guest"]})[0] == 200
    status, state = patch(server, library, {"name": "Library study rooms"})
    assert status == 200 and state == {"shareId": library["shareId"], "name": "Library study rooms",
                                       "visibility": "private", "viewerIds": ["demo-guest"]}, state
    shared = listed(server, "/api/scans/shared", GUEST)
    assert ids(shared) == [library["shareId"]] and shared[0]["owner"] == "demo-owner"
    assert shared[0]["name"] == "Library study rooms" and "viewerIds" not in shared[0]
    assert listed(server, "/api/scans/shared", VISITOR) == []
    assert listed(server, "/api/scans/shared", OWNER) == [] or library["shareId"] not in ids(
        listed(server, "/api/scans/shared", OWNER))
    status, _, body = request(server, "GET", "/api/shares/" + library["shareId"], headers=GUEST)
    assert status == 200 and json.loads(body)["name"] == "Library study rooms"
    for bad in ({}, {"name": ""}, {"name": "x" * 81}, {"owner": "me"}, {"visibility": "secret"}, {"viewerIds": "all"}):
        assert patch(server, library, bad)[0] == 400, bad
    assert patch(server, library, {"name": "Taken over"}, GUEST)[0] == 404

    assert patch(server, library, {"visibility": "public"})[0] == 200
    public = listed(server)
    assert public[0]["shareId"] == library["shareId"] and public[0]["name"] == "Library study rooms"

    # Only the owner can delete. Afterwards every route answers 404 and the lists drop it.
    assert request(server, "DELETE", "/api/scans/" + library["shareId"], headers=GUEST)[0] == 404
    assert request(server, "DELETE", "/api/scans/" + library["shareId"])[0] == 404
    status, _, body = request(server, "DELETE", "/api/scans/" + library["shareId"], headers=OWNER)
    assert status == 204 and body == b""
    check_access(server, library, OWNER, 404)
    for path, user in (("/api/scans/public", None), ("/api/scans/mine", OWNER), ("/api/scans/shared", GUEST)):
        assert library["shareId"] not in ids(listed(server, path, user)), path
    assert request(server, "DELETE", "/api/scans/" + library["shareId"], headers=OWNER)[0] == 404


def cues(server, ply):
    """Landmark cues (--demo-cues): owner reviews drafts, guests see approved directions only."""
    status, _, body = request(server, "POST", "/api/scans?format=ply&visibility=public", ply,
                              {"Content-Type": "application/octet-stream", **OWNER})
    assert status == 201
    share = json.loads(body)["shareId"]
    status, _, body = request(server, "GET", f"/api/shares/{share}")
    assert status == 200 and json.loads(body)["revisionId"] == share
    assert [s.get("revisionId") for s in listed(server, "/api/scans/mine", OWNER) if s["shareId"] == share] == [share]
    review = f"/api/scan-revisions/{share}/cues"
    for user in (None, GUEST):
        assert request(server, "GET", review, headers=user)[0] == 404, user
    status, _, body = request(server, "GET", review, headers=OWNER)
    drafts = json.loads(body)["cues"]
    assert status == 200 and len(drafts) == 2 and {c["status"] for c in drafts} == {"draft"}
    assert set(drafts[0]) == {"id", "routeSegmentId", "landmark", "instruction", "confidence", "status", "sourceFrameIds"}
    guest_view = f"/api/shares/{share}/cues"
    assert json.loads(request(server, "GET", guest_view)[2])["cues"] == []

    def edit(cue_id, change, user=OWNER):
        status, _, body = request(server, "PATCH", f"/api/cues/{cue_id}", json.dumps(change).encode(),
                                  {"Content-Type": "application/json", **user})
        return status, json.loads(body) if body else None

    first, second = drafts[0]["id"], drafts[1]["id"]
    assert edit(first, {"status": "approved"}, GUEST)[0] == 404
    for bad in ({}, {"status": "published"}, {"instruction": " "}, {"instruction": "x" * 201}, {"other": 1}):
        assert edit(first, bad)[0] == 400, bad
    status, body = edit(first, {"instruction": "  Turn left at the   amber door. ", "status": "approved"})
    assert status == 200 and body["cue"]["instruction"] == "Turn left at the amber door."
    assert edit(second, {"status": "rejected"})[1]["cue"]["status"] == "rejected"
    approved = json.loads(request(server, "GET", guest_view)[2])["cues"]
    assert [c["instruction"] for c in approved] == ["Turn left at the amber door."]
    assert edit(first, {"status": "draft"})[0] == 200
    assert json.loads(request(server, "GET", guest_view)[2])["cues"] == []


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
    with TemporaryDirectory() as directory, ScanServer(0, directory, with_demo_cues=True) as server:
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            cues(server, args.fixture.read_bytes())
        finally:
            server.shutdown()
            thread.join()
    print("Verified scan bytes, all three visibility modes, grants, revocation, upload failures, "
          "names, owner and shared lists, partial changes, deletion, and landmark cue review.")


if __name__ == "__main__":
    main()
