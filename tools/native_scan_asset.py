"""Validate the self-contained GLB layout written by the iOS scanner."""

import json
import math
import struct


def validate_native_model(path):
    with path.open("rb") as src:
        total = path.stat().st_size
        header = src.read(20)
        if len(header) != 20:
            raise ValueError("Truncated GLB")
        magic, version, size, length, kind = struct.unpack("<4sIII4s", header)
        if (
            (magic, version, size, kind) != (b"glTF", 2, total, b"JSON")
            or not 0 < length <= min(2**20, total - 28)
            or length % 4
        ):
            raise ValueError("Invalid native GLB header")
        doc = json.loads(src.read(length))
        binary_size, kind = struct.unpack("<I4s", src.read(8))
        if kind != b"BIN\0" or binary_size % 4 or total != 28 + length + binary_size:
            raise ValueError("Incomplete native GLB binary chunk")

    def integer(value):
        if type(value) is not int or value < 0:
            raise ValueError("Invalid buffer index or length")
        return value

    def item(entries, index):
        return entries[integer(index)]

    if (
        doc["asset"]["version"] != "2.0"
        or len(doc["buffers"]) != 1
        or not doc["meshes"]
    ):
        raise ValueError("Expected a single embedded geometry buffer")
    buffer_len = integer(doc["buffers"][0]["byteLength"])
    if not buffer_len <= binary_size <= buffer_len + 3:
        raise ValueError("Invalid native geometry buffer size")

    def local(value):
        if isinstance(value, dict):
            if "uri" in value or any(
                k != "KHR_materials_unlit" for k in value.get("extensions", {})
            ):
                raise ValueError("Expected embedded scan resources")
            for child in value.values():
                local(child)
        elif isinstance(value, list):
            for child in value:
                local(child)

    local(doc)
    if set(doc.get("extensionsRequired", [])) - {"KHR_materials_unlit"}:
        raise ValueError("Unsupported native material extension")
    views, attrs = doc["bufferViews"], doc["accessors"]
    for view in views:
        if (
            view["buffer"] != 0
            or integer(view.get("byteOffset", 0)) + integer(view["byteLength"])
            > buffer_len
        ):
            raise ValueError("Geometry extends beyond the GLB")
    for a in attrs:
        view = item(views, a["bufferView"])
        count = integer(a["count"])
        width = {"VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]] * {5121: 1, 5126: 4}[
            a["componentType"]
        ]
        if (
            not 0 < count <= 1_500_000
            or "sparse" in a
            or "byteStride" in view
            or integer(a.get("byteOffset", 0)) + count * width > view["byteLength"]
        ):
            raise ValueError("Invalid scan vertex data")
    for mesh in doc["meshes"]:
        if not mesh["primitives"]:
            raise ValueError("Empty scan")
        for primitive in mesh["primitives"]:
            a = item(attrs, primitive["attributes"]["POSITION"])
            mode = primitive.get("mode", 4)
            if (
                a["type"] != "VEC3"
                or a["componentType"] != 5126
                or mode not in (0, 4)
                or (mode == 4 and a["count"] % 3)
            ):
                raise ValueError("Expected native triangles or a point cloud")
            for label in ("min", "max"):
                if len(a[label]) != 3 or not all(math.isfinite(v) for v in a[label]):
                    raise ValueError("Invalid scan bounds")
            if any(
                item(attrs, i)["count"] != a["count"]
                for i in primitive["attributes"].values()
            ):
                raise ValueError("Mismatched vertex attributes")
    for image in doc.get("images", []):
        item(views, image["bufferView"])
        if image["mimeType"] != "image/jpeg":
            raise ValueError("Expected embedded scan photos")
