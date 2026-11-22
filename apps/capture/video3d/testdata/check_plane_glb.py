"""Verify baseline-preserving GLB composition across a texture, buffer padding and indices."""

import hashlib
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mesh_geometry import _accessor, _pack_glb, _read_glb, _source_arrays, export_glb
from plane_glb import merge
from check_mesh_geometry import native_glb, rejected


def scene(folder, name, color, dx):
    tex = np.full((3, 2, 3), color, dtype=np.uint8)
    uri = f"{name}.png"
    assert cv2.imwrite(str(folder / uri), tex)
    positions = np.array([[0, 0], [1, 0], [0, 1], [1, 1]], np.float32)
    triangles = np.array([[0, 1, 2], [1, 2, 3]], np.uint32)
    native, derived = folder / f"native-{name}.glb", folder / f"{name}.glb"
    native_glb(native, positions, triangles, uri)
    pose = np.eye(4)
    pose[0, 3] = dx
    export_glb(native, pose, derived)
    return derived


def samples(doc, blob, which, directory):
    views = _source_arrays(doc, blob, directory)
    n = doc["scenes"][0]["nodes"][which]
    mesh = doc["meshes"][doc["nodes"][n]["mesh"]]
    p = mesh["primitives"][0]
    tex_id = doc["materials"][p["material"]]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    tex = doc["textures"][tex_id]
    image = doc["images"][tex["source"]]
    return (_accessor(doc, views, p["attributes"]["POSITION"], "VEC3", {5126}).tobytes(),
            _accessor(doc, views, p["attributes"]["TEXCOORD_0"], "VEC2", {5126}).tobytes(),
            _accessor(doc, views, p["indices"], "SCALAR", {5125}).tobytes(),
            bytes(views[image["bufferView"]]), doc["samplers"][tex["sampler"]])


def run(folder):
    base = scene(folder, "base", [0, 0, 220], 0)
    patch = scene(folder, "new", [20, 210, 5], 3)
    out = folder / "comparison.glb"
    base_doc, base_buf = _read_glb(base)
    patch_doc, patch_buf = _read_glb(patch)
    stats = merge(base, patch, out)
    doc, buf = _read_glb(out)
    assert (stats["base_triangles"], stats["added_triangles"], stats["triangles"]) == (2, 2, 4)
    assert stats["base_binary_sha256"] == hashlib.sha256(buf[:len(base_buf)]).hexdigest()
    assert buf[:len(base_buf)] == base_buf
    for key in ("meshes", "materials", "nodes", "images", "textures", "accessors", "bufferViews", "samplers"):
        assert doc[key][:len(base_doc[key])] == base_doc[key], key
    assert doc["nodes"][1]["name"] == doc["meshes"][1]["name"] == "Plane fills"
    assert doc["nodes"][1]["extras"]["pathPlaneFills"]
    assert samples(doc, buf, 0, folder) == samples(base_doc, base_buf, 0, folder)
    assert samples(doc, buf, 1, folder) == samples(patch_doc, patch_buf, 0, folder)
    duplicate = folder / "no-planes.glb"
    noop = merge(base, None, duplicate)
    assert noop["added_triangles"] == 0 and duplicate.read_bytes() == base.read_bytes()
    try:
        merge(base, None, out)
    except FileExistsError:
        pass
    else:
        raise AssertionError("Existing comparison was overwritten")
    assert _read_glb(out)[0] == doc
    for key, invalid in (("images", [{"uri": "external.png"}]), ("nodes", [{"mesh": 0, "children": [0]}]),
                         ("textures", [{"source": 312}]), ("extensionsUsed", ["KHR_draco_mesh_compression"])):
        bad = folder / f"{key}.glb"
        _pack_glb({**patch_doc, key: invalid}, bytearray(patch_buf), bad)
        rejected(merge, base, bad, folder / "invalid.glb")
        assert not (folder / "invalid.glb").exists()
    truncated = folder / "bad.glb"
    truncated.write_bytes(patch.read_bytes()[:-1])
    rejected(merge, base, truncated, folder / "invalid.glb")


if __name__ == "__main__":
    with TemporaryDirectory() as tmp:
        run(Path(tmp))
    print("Verified original mesh, material and texture bytes, offset patch references, and byte-identical empty completion.")
