"""Add one photographed plane-fill mesh without changing baseline mesh data."""

import hashlib
import os
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory

import numpy as np

from mesh_geometry import _accessor, _item, _pack_glb, _read_glb, _source_arrays
from preview import check_glb


TABLES = ("bufferViews", "accessors", "images", "samplers", "textures", "materials", "meshes", "nodes")
UNLIT = "KHR_materials_unlit"


def _digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _fields(item, allowed):
    if not isinstance(item, dict) or item.keys() - set(allowed.split()):
        raise ValueError(f"Unsupported GLB object. Expected fields from {allowed}.")


def _load(path):
    """Validate the flat, self-contained RGB-textured GLB emitted by the capture pipeline."""
    check_glb(path)
    doc, binary = _read_glb(path)
    try:
        _fields(doc, "asset scene scenes buffers extensionsUsed extensionsRequired " + " ".join(TABLES))
        if doc["asset"]["version"] != "2.0" or doc.get("scene", 0) != 0:
            raise ValueError("Expected glTF 2.0 with scene zero active.")
        if (set(doc.get("extensionsUsed", [])) | set(doc.get("extensionsRequired", []))) - {UNLIT}:
            raise ValueError("Unsupported GLB extension.")
        if len(doc["scenes"]) != 1 or len(doc["nodes"]) != 1 or len(doc["meshes"]) != 1:
            raise ValueError("Expected one scene, one identity node and one mesh per input.")
        _fields(doc["scenes"][0], "nodes name")
        _fields(doc["nodes"][0], "mesh name")
        _fields(doc["meshes"][0], "primitives name")
        if doc["scenes"][0]["nodes"] != [0] or doc["nodes"][0]["mesh"] != 0:
            raise ValueError("Unexpected mesh node or active scene root.")
        if len(doc["buffers"]) != 1 or "uri" in doc["buffers"][0]:
            raise ValueError("Expected one embedded GLB binary buffer.")
        views = _source_arrays(doc, binary, path.parent)
        size = doc["buffers"][0]["byteLength"]
        if len(binary) - size > 3:
            raise ValueError("Unexpected data after the embedded buffer.")
        for view in doc["bufferViews"]:
            _fields(view, "buffer byteOffset byteLength byteStride target name")
        for acc in doc["accessors"]:
            _fields(acc, "bufferView byteOffset componentType count type min max normalized name")
            _item(views, acc["bufferView"])
        for image in doc["images"]:
            _fields(image, "bufferView mimeType name")
            img = _item(views, image["bufferView"])
            mime = image["mimeType"]
            if not ((mime == "image/png" and img[:8] == b"\x89PNG\r\n\x1a\n")
                    or (mime == "image/jpeg" and img[:2] == b"\xff\xd8")):
                raise ValueError("Expected an embedded PNG or JPEG texture.")
        for tex in doc["textures"]:
            _fields(tex, "source sampler name")
            _item(doc["images"], tex["source"])
            if "sampler" in tex:
                _item(doc["samplers"], tex["sampler"])
        for mat in doc["materials"]:
            _fields(mat, "name doubleSided pbrMetallicRoughness alphaMode alphaCutoff extensions")
            if any(k != UNLIT or v != {} for k, v in mat.get("extensions", {}).items()):
                raise ValueError("Unsupported material extension.")
            pbr = mat["pbrMetallicRoughness"]
            _fields(pbr, "baseColorTexture baseColorFactor metallicFactor roughnessFactor")
            info = pbr["baseColorTexture"]
            _fields(info, "index texCoord")
            if info.get("texCoord", 0) != 0:
                raise ValueError("Expected photo textures on TEXCOORD_0.")
            _item(doc["textures"], info["index"])

        triangles = 0
        for prim in doc["meshes"][0]["primitives"]:
            _fields(prim, "attributes indices material mode")
            attr = prim["attributes"]
            _fields(attr, "POSITION NORMAL TEXCOORD_0")
            _item(doc["materials"], prim["material"])
            xyz = _accessor(doc, views, attr["POSITION"], "VEC3", {5126})
            uv = _accessor(doc, views, attr["TEXCOORD_0"], "VEC2", {5126})
            indices = _accessor(doc, views, prim["indices"], "SCALAR", {5121, 5123, 5125})
            if (prim.get("mode", 4) != 4 or len(indices) % 3 or len(uv) != len(xyz)
                    or indices.max() >= len(xyz) or not np.isfinite(xyz).all() or not np.isfinite(uv).all()):
                raise ValueError("Invalid textured triangles in GLB.")
            if "NORMAL" in attr:
                normals = _accessor(doc, views, attr["NORMAL"], "VEC3", {5126})
                if len(normals) != len(xyz) or not np.isfinite(normals).all():
                    raise ValueError("Invalid surface normals in GLB.")
            triangles += len(indices) // 3
        doc.setdefault("samplers", [])
        return doc, binary, triangles
    except (KeyError, TypeError, IndexError, AttributeError) as exc:
        raise ValueError(f"Invalid GLB schema in {path.name}: {exc}") from exc


def _append(base, patch, start):
    """Rebase just the appended objects' references. The original tables keep their indices."""
    offsets = {key: len(base[key]) for key in TABLES}
    for v in patch["bufferViews"]:
        v["byteOffset"] = start + v.get("byteOffset", 0)
    for acc in patch["accessors"]:
        acc["bufferView"] += offsets["bufferViews"]
    for img in patch["images"]:
        img["bufferView"] += offsets["bufferViews"]
    for tex in patch["textures"]:
        tex["source"] += offsets["images"]
        if "sampler" in tex:
            tex["sampler"] += offsets["samplers"]
    for mat in patch["materials"]:
        mat["pbrMetallicRoughness"]["baseColorTexture"]["index"] += offsets["textures"]
    mesh = patch["meshes"][0]
    for prim in mesh["primitives"]:
        prim["attributes"] = {name: index + offsets["accessors"] for name, index in prim["attributes"].items()}
        prim["indices"] += offsets["accessors"]
        prim["material"] += offsets["materials"]
    mesh["name"] = patch["nodes"][0]["name"] = "Plane fills"
    patch["nodes"][0]["extras"] = {"pathPlaneFills": True}
    patch["nodes"][0]["mesh"] += offsets["meshes"]
    for key in TABLES:
        base[key].extend(patch[key])
    base["scenes"][0]["nodes"].append(offsets["nodes"])
    for key in ("extensionsUsed", "extensionsRequired"):
        if key in patch:
            base[key] = list(dict.fromkeys(base.get(key, []) + patch[key]))


def merge(base_path, patch_path_or_None, output_path):
    """Write a new GLB; no accepted faces preserves the whole baseline file byte-for-byte."""
    base_path, output = Path(base_path), Path(output_path)
    base, binary, original = _load(base_path)
    if not original:
        raise ValueError("Expected a nonempty baseline mesh.")
    added = 0
    patch_sha = None
    if patch_path_or_None is not None:
        patch_path = Path(patch_path_or_None)
        patch, patch_binary, added = _load(patch_path)
        patch_sha = _digest(patch_path)
    base_sha = _digest(base_path)
    with TemporaryDirectory(dir=output.parent) as folder:
        ready = Path(folder) / "merged.glb"
        if added:
            # The GLB binary chunk already includes its four-byte alignment padding.
            _append(base, patch, len(binary))
            buf = bytearray(binary)
            buf.extend(memoryview(patch_binary)[:patch["buffers"][0]["byteLength"]])
            _pack_glb(base, buf, ready)
        else:
            shutil.copyfile(base_path, ready)
        output_sha = _digest(ready)
        os.link(ready, output)  # Publish atomically, without overwriting an earlier trial.
    return {"base_triangles": original, "added_triangles": added, "triangles": original + added,
            "base_sha256": base_sha, "base_binary_sha256": hashlib.sha256(binary).hexdigest(),
            "patch_sha256": patch_sha, "output_sha256": output_sha, "bytes": output.stat().st_size}
