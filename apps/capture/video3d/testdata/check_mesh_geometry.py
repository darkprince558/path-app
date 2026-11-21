"""Exercise native mesh import, support filtering and self-contained textured GLB export."""

import json
from pathlib import Path
import struct
import sys
from tempfile import TemporaryDirectory

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mesh_geometry import clean_mesh, export_glb, _read_glb, _accessor, _source_arrays


def ply(path, positions, faces=None):
    with path.open("w") as file:
        file.write(f"ply\nformat ascii 1.0\nelement vertex {len(positions)}\n")
        file.write("property float x\nproperty float y\nproperty float z\n")
        if faces is not None:
            file.write(f"element face {len(faces)}\nproperty list uchar int vertex_indices\n")
        file.write("end_header\n")
        for row in positions:
            file.write(" ".join(map(str, row)) + "\n")
        for face in faces or []:
            file.write(f"{len(face)} " + " ".join(map(str, face)) + "\n")


def rejected(fn, *args):
    try:
        fn(*args)
    except ValueError:
        return
    raise AssertionError("Invalid input was accepted")


def check_surface(work):
    square = np.array([[0., 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [.5, .5, 0]])
    faces = [[i, (i + 1) % 4, 4] for i in range(4)]
    faces += [[v + 5 for v in face] for face in faces]
    island = [[11, 0, 0], [11.03, 0, 0], [11, .03, 0]]
    xyz = np.vstack((square, square + [4, 0, 0], island, [[np.nan, 0, 0], [15, 0, 0]]))
    faces += [[10, 11, 12], [4, 1, 0], [0, 0, 1], [1, 7, 4], [13, 0, 1], [27, 0, 1]]
    grid = [(i / 25 + offset, j / 25, 0) for offset in (0, 4, 11) for i in range(26) for j in range(26)]
    ply(work / "dense.ply", grid)
    ply(work / "raw.ply", xyz, faces)
    stats = clean_mesh(work / "raw.ply", work / "dense.ply", work / "clean.ply")
    for label in ("invalid_index_faces_removed", "duplicate_faces_removed", "nonfinite_faces_removed",
                  "degenerate_faces_removed", "unsupported_faces_removed", "island_faces_removed"):
        assert stats[label] == 1, (label, stats)
    assert (stats["components_kept"], stats["output_vertices"], stats["output_triangles"]) == (2, 10, 8)
    for invalid_faces in ([[0, 1, 2, 3]], None, []):
        ply(work / "bad.ply", square, invalid_faces)
        rejected(clean_mesh, work / "bad.ply", work / "dense.ply", work / "unexpected.ply")
    bad = (work / "clean.ply").read_bytes()[:-3]
    (work / "bad.ply").write_bytes(bad)
    rejected(clean_mesh, work / "bad.ply", work / "dense.ply", work / "unexpected.ply")
    assert not (work / "unexpected.ply").exists()


def native_glb(path, uv, triangles, image_uri="atlas.png"):
    position = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 1, 1]], "<f4")
    parts = [position.tobytes(), triangles.astype("<u4").tobytes(), uv.astype("<f4").tobytes()]
    data = b"".join(parts)
    doc = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
           "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 2},
                                      "indices": 1, "material": 0}]}],
           "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
           "textures": [{"source": 0}], "images": [{"uri": image_uri}], "buffers": [{"byteLength": len(data)}],
           "bufferViews": [{"buffer": 0, "byteOffset": sum(map(len, parts[:i])), "byteLength": len(part)}
                           for i, part in enumerate(parts)],
           "accessors": [{"bufferView": 0, "count": 4, "componentType": 5126, "type": "VEC3"},
                         {"bufferView": 1, "count": triangles.size, "componentType": 5125, "type": "SCALAR"},
                         {"bufferView": 2, "count": len(uv), "componentType": 5126, "type": "VEC2"}]}
    text = json.dumps(doc).encode()
    text += b" " * (-len(text) % 4)
    path.write_bytes(struct.pack("<4sIIII", b"glTF", 2, 28 + len(text) + len(data), len(text), 0x4e4f534a)
                     + text + struct.pack("<I4s", len(data), b"BIN\0") + data)
    return position


def check_texture(work):
    atlas = np.array([[[255, 0, 0], [0, 255, 0]], [[0, 0, 255], [255, 255, 255]]], np.uint8)
    assert cv2.imwrite(str(work / "atlas.png"), atlas)
    uv = np.array([[0, 0], [1, 0], [0, 1], [0, 1]], "<f4")
    indices = np.array([[0, 1, 2], [2, 3, 2]])
    native, result = work / "native.glb", work / "result.glb"
    position = native_glb(native, uv, indices)
    transform = np.array([[0, -1, 0, 3], [1, 0, 0, -2], [0, 0, 1, 1], [0, 0, 0, 1]])
    exported = export_glb(native, transform, result)
    assert exported["triangles"] == exported["untextured_faces_removed"] == 1
    doc, binary = _read_glb(result)
    assert "uri" not in doc["images"][0] and "uri" not in doc["buffers"][0]
    views = _source_arrays(doc, binary, work)
    pr = doc["meshes"][0]["primitives"][0]
    xyz = _accessor(doc, views, pr["attributes"]["POSITION"], "VEC3", {5126})
    assert np.allclose(xyz, position[:3] @ transform[:3, :3].T + transform[:3, 3])
    assert np.array_equal(_accessor(doc, views, pr["attributes"]["TEXCOORD_0"], "VEC2", {5126}), uv[:3])
    assert np.array_equal(_accessor(doc, views, pr["indices"], "SCALAR", {5125}).ravel(), [0, 1, 2])
    embedded = np.frombuffer(views[doc["images"][0]["bufferView"]], np.uint8)
    assert np.array_equal(cv2.imdecode(embedded, cv2.IMREAD_COLOR), atlas)
    other = work / "unexpected.glb"
    native_glb(native, uv, indices + 4)
    rejected(export_glb, native, transform, other)
    native_glb(native, uv, indices, "../atlas.png")
    rejected(export_glb, native, transform, other)
    native_glb(native, uv[:-1], indices)
    rejected(export_glb, native, transform, other)
    native.write_bytes(result.read_bytes()[:-8])
    rejected(export_glb, native, transform, other)
    assert not other.exists()


if __name__ == "__main__":
    with TemporaryDirectory() as directory:
        check_surface(Path(directory))
        check_texture(Path(directory))
    print("Verified cleanup preserves disconnected surfaces and embeds a validated, aligned photograph atlas.")
