"""Filter the native triangle surface and pack its photographed appearance in viewer coordinates."""

import base64
import json
from pathlib import Path
import struct
from urllib.parse import unquote, urlsplit

import cv2
import numpy as np
from plyfile import PlyData, PlyElement, PlyParseError
from scipy.sparse import coo_array
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree


def _read_ply(path, want_faces=False):
    try:
        ply = PlyData.read(str(path), known_list_len={"face": {"vertex_indices": 3}} if want_faces else {})
        fields = ply["vertex"].data
        coords = [fields[k] for k in "xyz"]
        if any(c.ndim != 1 or c.dtype.kind not in "iuf" for c in coords):
            raise ValueError("expected numeric scalar x, y and z")
        xyz = np.column_stack(coords).astype(np.float64)
        return xyz, ply["face"]["vertex_indices"] if want_faces else None
    except (PlyParseError, KeyError, IndexError, TypeError, ValueError, EOFError) as exc:
        raise ValueError(f"Invalid {'triangle mesh' if want_faces else 'dense cloud'} PLY {Path(path).name}: {exc}") from exc


def _supported_faces(triangles, samples):
    """Look for measured samples inside triangles as well as along their edges."""
    if len(samples) < 6:
        raise ValueError("At least six finite dense samples are required to test mesh support.")
    tree = cKDTree(samples)
    # Use the sixth neighbor to estimate spacing on each portion of the scan.
    # Clip extreme radii so isolated points cannot support a wall across an empty room.
    distance, _ = tree.query(samples, k=[6], workers=4)
    local = distance.ravel()
    positive = local[local > 0]
    if not len(positive):
        raise ValueError("The dense cloud has no measurable sample spacing.")
    median = float(np.median(positive))
    radius = 2.5 * np.clip(local, .5 * median, 3 * median)
    keep = np.ones(len(triangles), dtype=bool)
    for positions in (triangles.mean(axis=1), (triangles[:, 0] + triangles[:, 1]) * .5,
                      (triangles[:, 1] + triangles[:, 2]) * .5, (triangles[:, 2] + triangles[:, 0]) * .5):
        distance, nearest = tree.query(positions, workers=4)
        keep &= distance <= radius[nearest]
    # A broad triangle can pass the midpoint tests but span an unsampled hole
    # inside. Probe a sixths grid only for triangles wider than the local detail.
    squared_lengths = np.square(triangles - np.roll(triangles, 1, axis=1)).sum(axis=2)
    large = np.flatnonzero(keep & (squared_lengths.max(axis=1) >= (4 * median) ** 2))
    for i in range(1, 5):
        for j in range(1, 6 - i):
            k = 6 - i - j
            points = (i * triangles[large, 0] + j * triangles[large, 1] + k * triangles[large, 2]) / 6
            distance, nearest = tree.query(points, workers=4)
            keep[large] &= distance <= radius[nearest]
    return keep, median


def clean_mesh(native_mesh, dense_ply, cleaned_ply):
    """Write a compact binary triangle PLY in the original reconstruction frame."""
    xyz, faces = _read_ply(native_mesh, want_faces=True)
    if faces.dtype.hasobject:  # ASCII and non-memory-mappable encodings
        if not len(faces) or any(np.shape(row) != (3,) for row in faces):
            raise ValueError("Expected only triangle faces from ReconstructMesh.")
        faces = np.stack(faces)
    if faces.ndim != 2 or faces.shape[1] != 3 or not np.issubdtype(faces.dtype, np.integer):
        raise ValueError("Expected three integer indices per mesh face.")
    faces = faces.astype(np.int64)
    if not len(xyz) or not len(faces):
        raise ValueError("OpenMVS produced an empty mesh.")
    stats = {"input_vertices": len(xyz), "input_triangles": len(faces)}
    valid = (faces >= 0).all(axis=1) & (faces < len(xyz)).all(axis=1)
    faces = faces[valid]
    stats["invalid_index_faces_removed"] = int((~valid).sum())
    finite = np.isfinite(xyz).all(axis=1)
    stats["nonfinite_vertices"] = int((~finite).sum())
    faces = faces[finite[faces].all(axis=1)]
    stats["nonfinite_faces_removed"] = int(valid.sum() - len(faces))
    # Remove repeated triangles irrespective of winding. Keep the first winding.
    unique = np.unique(np.sort(faces, axis=1), axis=0, return_index=True)[1]
    stats["duplicate_faces_removed"] = len(faces) - len(unique)
    faces = faces[np.sort(unique)]
    triangles = xyz[faces]
    edge = triangles[:, 1:] - triangles[:, :1]
    area = np.linalg.norm(np.cross(edge[:, 0], edge[:, 1]), axis=1)
    valid = area > np.finfo(np.float64).eps * np.square(edge).sum(axis=(1, 2))
    faces = faces[valid]
    stats["degenerate_faces_removed"] = int((~valid).sum())

    dense, _ = _read_ply(dense_ply)
    dense = dense[np.isfinite(dense).all(axis=1)]
    supported, spacing = _supported_faces(xyz[faces], dense)
    faces = faces[supported]
    stats.update(unsupported_faces_removed=int((~supported).sum()), median_sixth_sample_distance=spacing)
    if not len(faces):
        raise ValueError("No nondegenerate triangles have nearby measured points.")
    # Connected surface islands may be meaningful on either side of a corner.
    # Keep each substantial island even when it is separate from the largest.
    rows = faces.ravel()
    cols = faces[:, [1, 2, 0]].ravel()
    graph = coo_array((np.ones(len(rows), np.uint8), (rows, cols)), shape=(len(xyz), len(xyz))).tocsr()
    _, components = connected_components(graph, directed=False)
    labels = components[faces[:, 0]]
    sizes = np.bincount(labels)
    min_faces = min(40, max(4, int(np.ceil(.00015 * len(faces)))))
    substantial = sizes >= min(min_faces, sizes.max())
    stats.update(components_before=int(np.count_nonzero(sizes)), components_kept=int(substantial.sum()),
                 minimum_component_triangles=int(min(min_faces, sizes.max())))
    keep = substantial[labels]
    faces = faces[keep]
    stats["island_faces_removed"] = int((~keep).sum())
    used, indices = np.unique(faces.ravel(), return_inverse=True)
    vertices = np.empty(len(used), dtype=[(axis, "<f4") for axis in "xyz"])
    for axis, values in zip("xyz", xyz[used].T):
        vertices[axis] = values
    records = np.empty(len(faces), dtype=[("vertex_indices", "<u4", 3)])
    records["vertex_indices"] = indices.reshape(-1, 3)
    output = PlyData([PlyElement.describe(vertices, "vertex"), PlyElement.describe(records, "face",
                      val_types={"vertex_indices": "u4"})], byte_order="<")
    with Path(cleaned_ply).open("xb") as stream:
        output.write(stream)
    return {**stats, "removed_or_unused_vertices": len(xyz) - len(used),
            "output_vertices": len(used), "output_triangles": len(faces)}


def _read_glb(path):
    with path.open("rb") as file:
        header = file.read(12)
        if len(header) != 12 or struct.unpack("<4sII", header) != (b"glTF", 2, path.stat().st_size):
            raise ValueError("Invalid glTF 2.0 binary header or file length.")
        parts = []
        for expected in (b"JSON", b"BIN\0"):
            chunk = file.read(8)
            if len(chunk) != 8:
                raise ValueError("Missing glTF chunk.")
            size, kind = struct.unpack("<I4s", chunk)
            if kind != expected or size % 4 or size > path.stat().st_size - file.tell():
                raise ValueError("Invalid glTF chunk type or length.")
            parts.append(file.read(size))
        if file.read(1):
            raise ValueError("Unexpected additional glTF chunks.")
    return json.loads(parts[0]), parts[1]


def _item(items, index):
    if type(index) is not int or not 0 <= index < len(items):
        raise ValueError("Invalid glTF object reference.")
    return items[index]


def _resource(uri, directory):
    if not isinstance(uri, str):
        raise ValueError("Missing GLB resource URI.")
    if uri.startswith("data:"):
        kind, separator, payload = uri.partition(",")
        if not separator or not kind.endswith(";base64"):
            raise ValueError("Invalid embedded GLB resource.")
        return base64.b64decode(payload, validate=True)
    parts = urlsplit(uri)
    location = (directory / unquote(parts.path)).resolve()
    if parts.scheme or parts.netloc or parts.query or parts.fragment or not location.is_relative_to(directory):
        raise ValueError("Texture and geometry resources must be local to the native export.")
    return location.read_bytes()


def _source_arrays(doc, binary, directory):
    buffers = []
    for index, buf in enumerate(doc["buffers"]):
        content = binary if index == 0 and "uri" not in buf else _resource(buf.get("uri"), directory)
        length = buf["byteLength"]
        if type(length) is not int or not 0 < length <= len(content):
            raise ValueError("Invalid GLB buffer length.")
        buffers.append(memoryview(content)[:length])
    views = []
    for view in doc["bufferViews"]:
        buf = _item(buffers, view["buffer"])
        begin, size = view.get("byteOffset", 0), view["byteLength"]
        if type(begin) is not int or type(size) is not int or begin < 0 or size < 1 or begin + size > len(buf):
            raise ValueError("Invalid GLB buffer view.")
        views.append(buf[begin:begin + size])
    return views


def _accessor(doc, views, index, form, types):
    spec = _item(doc["accessors"], index)
    count = spec["count"]
    if (spec["type"] != form or spec["componentType"] not in types or "sparse" in spec
            or type(count) is not int or count < 1 or spec.get("normalized")):
        raise ValueError("Unexpected native glTF accessor format.")
    dtype = np.dtype({5121: "u1", 5123: "<u2", 5125: "<u4", 5126: "<f4"}[spec["componentType"]])
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[form]
    data = _item(views, spec["bufferView"])
    stride = doc["bufferViews"][spec["bufferView"]].get("byteStride", dtype.itemsize * width)
    offset = spec.get("byteOffset", 0)
    if (type(stride) is not int or type(offset) is not int or stride < dtype.itemsize * width or offset < 0
            or stride % dtype.itemsize or offset % dtype.itemsize
            or offset + (count - 1) * stride + width * dtype.itemsize > len(data)):
        raise ValueError("GLB accessor exceeds its view or has invalid alignment.")
    return np.ndarray((count, width), dtype=dtype, buffer=data, offset=offset, strides=(stride, dtype.itemsize))


def _append_view(doc, buf, payload):
    buf.extend(b"\0" * (-len(buf) % 4))
    index = len(doc["bufferViews"])
    doc["bufferViews"].append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(payload)})
    buf.extend(payload)
    return index


def _append_accessor(doc, buf, array, form):
    data = np.ascontiguousarray(array)
    accession = {"bufferView": _append_view(doc, buf, data.tobytes()), "type": form, "count": len(data),
                 "componentType": 5126 if data.dtype == np.dtype("<f4") else 5125}
    if form == "VEC3":
        accession.update(min=data.min(axis=0).tolist(), max=data.max(axis=0).tolist())
    doc["accessors"].append(accession)
    return len(doc["accessors"]) - 1


def _pack_glb(doc, blob, output):
    doc["buffers"] = [{"byteLength": len(blob)}]
    blob.extend(b"\0" * (-len(blob) % 4))
    info = json.dumps(doc, separators=(",", ":"), allow_nan=False).encode()
    info += b" " * (-len(info) % 4)
    with Path(output).open("xb") as file:
        file.write(struct.pack("<4sII", b"glTF", 2, 28 + len(info) + len(blob)))
        for code, chunk in ((b"JSON", info), (b"BIN\0", blob)):
            file.write(struct.pack("<I4s", len(chunk), code))
            file.write(chunk)


def _export_glb(textured_asset, world_to_view, output_glb):
    """Pack OpenMVS 2.4 triangle geometry and atlas(es) as a single viewer-space GLB."""
    source = Path(textured_asset).resolve()
    native, binary = _read_glb(source)
    views = _source_arrays(native, binary, source.parent)
    transform = np.asarray(world_to_view, dtype=np.float64)
    if (transform.shape != (4, 4) or not np.isfinite(transform).all()
            or not np.allclose(transform[3], [0, 0, 0, 1])
            or not np.allclose(transform[:3, :3].T @ transform[:3, :3], np.eye(3), atol=1e-5)
            or not np.isclose(np.linalg.det(transform[:3, :3]), 1)):
        raise ValueError("Expected the original rigid world_to_view transform.")
    # The pinned exporter stores reconstruction-space positions on a flat identity
    # node. Reject unexpected transforms instead of silently rotating a scene twice.
    if _item(native["scenes"], native.get("scene", 0))["nodes"] != [0] or len(native["nodes"]) != 1:
        raise ValueError("Unexpected native mesh scene hierarchy.")
    node = native["nodes"][0]
    if any(key in node for key in ("matrix", "translation", "rotation", "scale", "children")):
        raise ValueError("Expected the native OpenMVS mesh to be in its reconstruction coordinates.")
    primitives = _item(native["meshes"], node["mesh"])["primitives"]
    mesh = {"name": "Textured hallway", "primitives": []}
    doc = {"asset": {"version": "2.0", "generator": "Path App / OpenMVS"},
           "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}], "meshes": [mesh],
           "extensionsUsed": ["KHR_materials_unlit"], "images": [], "textures": [], "materials": [],
           "accessors": [], "bufferViews": [], "samplers": [{"magFilter": 9729, "minFilter": 9729,
                                                              "wrapS": 33071, "wrapT": 33071}]}
    output = bytearray()
    textures = {}
    atlases = []
    vertices = faces = unmapped = 0
    for primitive in primitives:
        if primitive.get("mode", 4) != 4:
            raise ValueError("Expected textured triangle primitives.")
        attrs = primitive["attributes"]
        xyz = _accessor(native, views, attrs["POSITION"], "VEC3", {5126})
        uv = _accessor(native, views, attrs["TEXCOORD_0"], "VEC2", {5126})
        index = _accessor(native, views, primitive["indices"], "SCALAR", {5121, 5123, 5125})
        if (len(uv) != len(xyz) or not np.isfinite(xyz).all() or not np.isfinite(uv).all()
                or len(index) % 3 or index.max() >= len(xyz)):
            raise ValueError("Texture coordinates, positions or triangle indices are invalid.")
        tris = index.reshape(-1, 3)
        # TextureMesh assigns all three corners of an unobserved face a single
        # atlas texel. Such triangles would otherwise turn into solid neutral fill.
        coords = uv[tris]
        mapped = (coords != coords[:, :1]).any(axis=(1, 2))
        unmapped += int((~mapped).sum())
        if not mapped.any():
            continue
        used, remapped = np.unique(tris[mapped].ravel(), return_inverse=True)
        position = (xyz[used] @ transform[:3, :3].T + transform[:3, 3]).astype("<f4")
        uv = uv[used].astype("<f4")
        material = _item(native["materials"], primitive["material"])
        base = material["pbrMetallicRoughness"]["baseColorTexture"]
        if base.get("texCoord", 0) != 0:
            raise ValueError("Expected base color to use the native mesh UV set.")
        image_id = _item(native["textures"], base["index"])["source"]
        if image_id not in textures:
            image = _item(native["images"], image_id)
            pixels = (_resource(image["uri"], source.parent) if "uri" in image
                      else bytes(_item(views, image["bufferView"])))
            decoded = cv2.imdecode(np.frombuffer(pixels, np.uint8), cv2.IMREAD_UNCHANGED)
            if decoded is None or decoded.ndim != 3 or decoded.shape[2] not in (3, 4):
                raise ValueError("Undecodable photographed texture.")
            if pixels.startswith(b"\x89PNG\r\n\x1a\n"):
                mime = "image/png"
            elif pixels.startswith(b"\xff\xd8"):
                mime = "image/jpeg"
            else:
                raise ValueError("Expected a PNG or JPEG texture atlas.")
            atlases.append({"width": decoded.shape[1], "height": decoded.shape[0], "bytes": len(pixels)})
            textures[image_id] = len(doc["images"])
            doc["images"].append({"mimeType": mime, "bufferView": _append_view(doc, output, pixels)})
            doc["textures"].append({"source": textures[image_id], "sampler": 0})
            doc["materials"].append({"doubleSided": True, "extensions": {"KHR_materials_unlit": {}},
                                     "pbrMetallicRoughness": {"baseColorTexture": {"index": textures[image_id]},
                                                             "metallicFactor": 0, "roughnessFactor": 1}})
        mesh["primitives"].append({
            "mode": 4, "material": textures[image_id],
            "attributes": {"POSITION": _append_accessor(doc, output, position, "VEC3"),
                           "TEXCOORD_0": _append_accessor(doc, output, uv, "VEC2")},
            "indices": _append_accessor(doc, output, remapped.astype("<u4"), "SCALAR"),
        })
        vertices += len(used)
        faces += len(remapped) // 3
    if not faces:
        raise ValueError("No triangles reference a photographed region of the texture.")
    _pack_glb(doc, output, output_glb)
    return {"triangles": faces, "vertices": vertices, "untextured_faces_removed": unmapped,
            "texture_atlases": atlases, "bytes": Path(output_glb).stat().st_size}


def export_glb(textured_asset, world_to_view, output_glb):
    """Validate native geometry and package its textures with the viewer-space mesh."""
    try:
        return _export_glb(textured_asset, world_to_view, output_glb)
    except (KeyError, IndexError, TypeError, UnicodeError, struct.error, cv2.error) as exc:
        raise ValueError(f"Invalid OpenMVS textured GLB {Path(textured_asset).name}: {exc}") from exc
