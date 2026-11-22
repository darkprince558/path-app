import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

import numpy as np
import open3d as o3d
from PIL import Image
from reconstruct import reconstruct, section_folders


class WalkFusionTest(unittest.TestCase):
    def test_turn_with_shared_origin_and_rejected_depth(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            walk = str(uuid4()).upper()
            manifest = {"walkID": walk, "sections": []}
            for number in (1, 2):
                capture = str(uuid4()).upper()
                section = root / capture
                section.mkdir()
                manifest["sections"].append({"number": number, "scanID": capture, "path": capture})
                (section/"scan.json").write_text(json.dumps({"id": capture, "walkID": walk, "sectionNumber": number}))
                w = h = 48
                Image.new("RGB", (w,h), (40,180,90)).save(section/"photo.jpg")
                np.full((h,w), 2, dtype="<f4").tofile(section/"depth.f32")
                np.full((h,w), 2, dtype="u1").tofile(section/"confidence.u8")
                np.zeros((h,w), dtype="u1").tofile(section/"reject.u8")
                pose = np.eye(4)
                if number == 2:
                    pose[:3,:3] = [[0,0,-1],[0,1,0],[1,0,0]]
                    pose[:3,3] = [2,0,1]
                camera = {"cameraToWorld":pose.flatten(order="F").tolist(), "tracking":"normal",
                          "imageWidth":96,"imageHeight":96,"intrinsics":[96,0,0,0,96,0,48,48,1]}
                frame = {"camera":camera, "jpeg":"photo.jpg","depthMetersFloat32LE":"depth.f32",
                         "depthWidth":w,"depthHeight":h,"confidenceUInt8":"confidence.u8"}
                (section/"keyframes.json").write_text(json.dumps([frame,dict(frame,confidenceUInt8="reject.u8")]))
            (root/"walk.json").write_text(json.dumps(manifest))
            output = root/"walk.glb"
            with contextlib.redirect_stdout(io.StringIO()) as log:
                reconstruct(root,output)
            self.assertIn("2 frames integrated, 2 skipped", log.getvalue())
            mesh = o3d.io.read_triangle_mesh(str(output))
            v = np.asarray(mesh.vertices)
            self.assertTrue(mesh.has_vertex_colors())
            # The first wall is at z=-2 m. After the turn the second lies at x=4 m.
            self.assertGreater(np.sum(abs(v[:,2]+2)<.05),100)
            self.assertGreater(np.sum(abs(v[:,0]-4)<.05),100)
            self.assertFalse(np.any((v[:,0]>1.2)&(v[:,0]<3.8)))
            with self.assertRaises(ValueError): reconstruct(root,output)
            other = root/manifest["sections"][1]["path"]/"scan.json"
            record = json.loads(other.read_text())
            other.write_text(json.dumps(dict(record,walkID=str(uuid4()))))
            with self.assertRaises(ValueError): list(section_folders(root))


if __name__ == "__main__":
    unittest.main()
