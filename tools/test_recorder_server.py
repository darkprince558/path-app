"""Integration checks for the private, single-Mac recorder service."""
import contextlib
import http.client
import json
from pathlib import Path
import sqlite3
import struct
import tempfile
import threading
import time
import unittest
import uuid
from http.server import ThreadingHTTPServer

from recorder_server import Captures, RecorderHandler, VIDEO_LIMIT


def triangle():
    source = (Path(__file__).resolve().parents[1] / "fixtures/venue/sample-triangle.glb").read_bytes()
    length = struct.unpack_from("<I", source, 12)[0]
    doc = json.loads(source[20:20 + length])
    doc["images"] = [{"uri": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5o8AAAAASUVORK5CYII="}]
    doc["textures"] = [{"source": 0}]
    desc = json.dumps(doc).encode()
    desc += b" " * (-len(desc) % 4)
    chunks = struct.pack("<I4s", len(desc), b"JSON") + desc + source[20 + length:]
    return struct.pack("<4sII", b"glTF", 2, 12 + len(chunks)) + chunks


class RecorderTransport(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.temp = temporary.name
        self.data = Path(self.temp) / "private"
        self.dist = Path(self.temp) / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text("<title>Path test</title>")
        self.capture = str(uuid.uuid4())
        self.prefix = "/api/captures/" + self.capture
        self.model = triangle()
        self.video = struct.pack(">I4s", 16, b"ftyp") + b"isom0000"  # transport-only signature
        self.motion = json.dumps({"version": 1, "timebase": "recording-start-ms", "durationMs": 4000,
                                  "permission": "denied", "samples": []}).encode()
        self.calls = 0

    @contextlib.contextmanager
    def serve(self):
        def process(job, pipeline, progress):
            self.assertEqual((job / "input.video").read_bytes(), self.video)
            self.assertEqual((job / "motion.json").read_bytes(), self.motion)
            self.calls += 1
            progress("Testing the finished asset")
            out = job / "test-mesh.glb"
            out.write_bytes(self.model)
            return out

        with ThreadingHTTPServer(("127.0.0.1", 0), RecorderHandler) as server:
            captures = server.captures = Captures(self.data, Path("hallway3d"), process)
            self.key = captures.key
            server.dist = self.dist
            self.port = server.server_port
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                yield
            finally:
                server.shutdown()
                thread.join()
                captures.close()

    def request(self, method, path, body=None, media=None, *, auth=True, headers=None):
        headers = dict(headers or {})
        if auth:
            headers["Authorization"] = "Bearer " + self.key
        if media:
            headers["Content-Type"] = media
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers)
            reply = conn.getresponse()
            data = reply.read()
            if data and reply.getheader("Content-Type", "").startswith("application/json"):
                data = json.loads(data)
            return reply.status, data
        finally:
            conn.close()

    def ready(self):
        until = time.monotonic() + 4
        while time.monotonic() < until:
            status, job = self.request("GET", self.prefix)
            if status == 200 and job["status"] == "ready":
                return job["sharePath"]
            time.sleep(.02)
        self.fail("Job did not reach ready")

    def test_upload_queue_share_restart(self):
        with self.serve():
            self.assertEqual((self.data / "organizer.key").stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.request("GET", "/", auth=False)[0], 302)
            self.assertEqual(self.request("GET", "/record", auth=False)[0], 200)
            for suffix in ("", "/video", "/motion", "/process"):
                self.assertEqual(self.request("GET", self.prefix + suffix, auth=False)[0], 401)
            self.assertEqual(self.request("POST", self.prefix + "/process")[0], 409)
            self.assertEqual(self.request("PUT", self.prefix + "/video", b"x"*18, "video/mp4")[0], 400)
            self.assertEqual(self.request("PUT", self.prefix + "/motion", b"{}", "application/json")[0], 400)
            self.assertEqual(self.request("PUT", self.prefix + "/video", b"x", "video/mp4",
                                          headers={"Content-Length": str(VIDEO_LIMIT+1)})[0], 413)
            self.assertEqual(self.request("GET", self.prefix)[0], 404)
            for _ in range(2):
                self.assertEqual(self.request("PUT", self.prefix+"/video", self.video, "video/mp4")[0], 200)
            self.assertEqual(self.request("PUT", self.prefix+"/video", self.video+b"A", "video/mp4")[0], 409)
            _, job = self.request("PUT", self.prefix+"/motion", self.motion, "application/json")
            self.assertEqual(job["motionSummary"]["permission"], "denied")
            for _ in range(4):
                self.assertIn(self.request("POST", self.prefix+"/process")[0], (200, 202))
            share = self.ready()
            self.assertEqual(self.calls, 1)
            meta_path = share.replace("/s/", "/api/shares/")
            _, meta = self.request("GET", meta_path, auth=False)
            self.assertEqual(set(meta), {"format", "shareId", "assetPath"})
            self.assertEqual(meta["format"], "glb")
            self.assertEqual(self.request("GET", meta["assetPath"], auth=False), (200, self.model))
            for p in ("/api/scans/public", "/organizer.key", self.prefix+"/motion",
                      "/jobs/"+self.capture+"/input.video", "/assets/../organizer.key"):
                self.assertIn(self.request("GET", p, auth=False)[0], (401, 404))
        with self.serve():
            self.assertEqual(self.ready(), share)
            self.assertEqual(self.request("GET", share, auth=False)[0], 200)
            self.assertEqual(self.request("GET", meta["assetPath"], auth=False)[1], self.model)
            self.assertEqual(self.calls, 1)

    def test_native_model_share_survives_restart(self):
        path = '/api/native-scans/' + self.capture
        binary = struct.pack('<6f', 0, 0, 0, 1, 1, 1)
        doc = {"asset":{"version":"2.0"}, "buffers":[{"byteLength":len(binary)}],
               "bufferViews":[{"buffer":0,"byteLength":len(binary)}],
               "accessors":[{"bufferView":0,"type":"VEC3","componentType":5126,"count":2,"min":[0,0,0],"max":[1,1,1]}],
               "meshes":[{"primitives":[{"mode":0,"attributes":{"POSITION":0}}]}],
               "nodes":[{"mesh":0}],"scenes":[{"nodes":[0]}],"scene":0}
        def encode():
            desc=json.dumps(doc).encode();desc += b' ' * (-len(desc)%4)
            return struct.pack('<4sIII4s', b'glTF',2,28+len(desc)+len(binary),len(desc),b'JSON')+desc+struct.pack('<I4s',len(binary),b'BIN\0')+binary
        payload=encode()
        with self.serve():
            self.assertEqual(self.request('PUT',path,payload,'model/gltf-binary',auth=False)[0],401)
            self.assertEqual(self.request('PUT',path,payload[:25],'model/gltf-binary')[0],400)
            doc['buffers'][0]['uri']='external.bin'
            self.assertEqual(self.request('PUT',path,encode(),'model/gltf-binary')[0],400)
            del doc['buffers'][0]['uri']
            code,reply=self.request('PUT',path,payload,'model/gltf-binary');self.assertEqual(code,200)
            self.assertEqual(self.request('PUT',path,payload,'model/gltf-binary')[1],reply)
            doc['asset']['generator']='another scan'
            self.assertEqual(self.request('PUT',path,encode(),'model/gltf-binary')[0],409)
            asset=reply['sharePath'].replace('/s/','/api/shares/')+'/asset'
        with self.serve():
            self.assertEqual(self.request('GET',asset,auth=False),(200,payload))
            self.assertEqual(self.calls,0)

    def test_interrupted_worker_requeued(self):
        with self.serve():
            self.request("PUT", self.prefix+"/video", self.video, "video/quicktime")
            self.request("PUT", self.prefix+"/motion", self.motion, "application/json")
        # Persist exactly the status a sudden Mac restart would have left behind.
        with sqlite3.connect(self.data/"captures.sqlite") as db:
            db.execute("UPDATE captures SET status='processing' WHERE id=?", (self.capture,))
        with self.serve():
            self.assertTrue(self.ready().startswith("/s/"))
            self.assertEqual(self.calls, 1)


if __name__ == "__main__":
    unittest.main()
