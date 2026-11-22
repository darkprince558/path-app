#!/usr/bin/env python3
"""Fill small holes in a phone scan before uploading it to Not 404.

Rebuilds the surface with screened Poisson reconstruction (Open3D), then keeps only
new surface that lies close to the original scan. Small gaps (missed patches of wall
or floor, cracks between depth frames) get filled, but doorways, open ends and big
unscanned areas are NOT bridged with invented walls. Colours are carried over from the
nearest scanned points.

    python tools/scan_fill_holes.py hallway.glb hallway-filled.glb
    python tools/scan_fill_holes.py hallway.glb hallway-filled.glb --max-gap 0.15 --depth 10

Input: a GLB from Path Capture (POSITION, optional NORMAL and COLOR_0; metres, +Y up).
Output: one mesh with POSITION, NORMAL and COLOR_0 (camera sRGB bytes, like Path
Capture), generator "Path Capture (hole-filled)", so the website treats it like the
original scan. Needs: pip install open3d numpy
"""

import argparse
import json
import struct
import sys
import time
from pathlib import Path

import numpy as np

COMPONENTS = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
SIZES = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path):
    """Returns (positions, normals or None, colours 0-1 or None, triangles) merged from every triangle primitive."""
    data = Path(path).read_bytes()
    magic, version, _ = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2:
        sys.exit(f"{path} is not a binary glTF 2.0 file")
    json_len = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + json_len])
    if doc.get("extensionsRequired"):
        sys.exit(f"{path} uses {', '.join(doc['extensionsRequired'])}. Run this on the uncompressed scan, then compress.")
    offset = 20 + json_len
    binary = b""
    if offset + 8 <= len(data):
        bin_len = struct.unpack_from("<I", data, offset)[0]
        binary = data[offset + 8: offset + 8 + bin_len]

    def accessor(index):
        acc = doc["accessors"][index]
        view = doc["bufferViews"][acc["bufferView"]]
        dtype = np.dtype(COMPONENTS[acc["componentType"]])
        width = SIZES[acc["type"]]
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        stride = view.get("byteStride", 0) or dtype.itemsize * width
        rows = np.ndarray((acc["count"], width), dtype=dtype, buffer=binary, offset=start, strides=(stride, dtype.itemsize))
        values = rows.astype(np.float64)
        if acc.get("normalized"):
            values /= float(np.iinfo(dtype).max)
        return values

    def node_matrices(node_index, parent):
        node = doc["nodes"][node_index]
        if "matrix" in node:
            local = np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
        else:
            t = np.array(node.get("translation", [0, 0, 0]), dtype=np.float64)
            x, y, z, w = node.get("rotation", [0, 0, 0, 1])
            r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                          [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                          [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
            s = np.diag(node.get("scale", [1, 1, 1]))
            local = np.eye(4)
            local[:3, :3] = r @ s
            local[:3, 3] = t
        world = parent @ local
        yield node, world
        for child in node.get("children", []):
            yield from node_matrices(child, world)

    scene = doc["scenes"][doc.get("scene", 0)]
    positions, normals, colours, triangles = [], [], [], []
    have_normals = have_colours = True
    base = 0
    for root in scene["nodes"]:
        for node, world in node_matrices(root, np.eye(4)):
            if "mesh" not in node:
                continue
            for prim in doc["meshes"][node["mesh"]]["primitives"]:
                if prim.get("mode", 4) != 4:
                    continue
                attrs = prim["attributes"]
                p = accessor(attrs["POSITION"])
                p = p @ world[:3, :3].T + world[:3, 3]
                idx = accessor(prim["indices"]).astype(np.int64).reshape(-1, 3) if "indices" in prim \
                    else np.arange(len(p)).reshape(-1, 3)
                positions.append(p)
                triangles.append(idx + base)
                base += len(p)
                if "NORMAL" in attrs:
                    n = accessor(attrs["NORMAL"]) @ np.linalg.inv(world[:3, :3])
                    normals.append(n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12))
                else:
                    have_normals = False
                if "COLOR_0" in attrs:
                    colours.append(accessor(attrs["COLOR_0"])[:, :3])
                else:
                    have_colours = False
    if not positions:
        sys.exit(f"{path} has no triangle meshes")
    return (np.concatenate(positions), np.concatenate(normals) if have_normals else None,
            np.concatenate(colours) if have_colours else None, np.concatenate(triangles))


def write_glb(path, positions, normals, colours, triangles, generator):
    """One primitive: POSITION, NORMAL, COLOR_0 (sRGB bytes), uint32 indices; unlit off, double-sided."""
    pos = positions.astype(np.float32)
    nor = normals.astype(np.float32)
    col = np.concatenate([np.clip(np.rint(colours * 255), 0, 255), np.full((len(colours), 1), 255)], axis=1).astype(np.uint8)
    idx = triangles.astype(np.uint32).reshape(-1)
    chunks, views, offset = [], [], 0
    for blob in (pos.tobytes(), nor.tobytes(), col.tobytes(), idx.tobytes()):
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob)})
        padded = blob + b"\0" * (-len(blob) % 4)
        chunks.append(padded)
        offset += len(padded)
    binary = b"".join(chunks)
    doc = {
        "asset": {"version": "2.0", "generator": generator},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2}, "indices": 3, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1}, "doubleSided": True}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3",
             "min": pos.min(axis=0).tolist(), "max": pos.max(axis=0).tolist()},
            {"bufferView": 1, "componentType": 5126, "count": len(nor), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5121, "normalized": True, "count": len(col), "type": "VEC4"},
            {"bufferView": 3, "componentType": 5125, "count": len(idx), "type": "SCALAR"},
        ],
    }
    text = json.dumps(doc, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(binary)
    Path(path).write_bytes(struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(text), 0x4E4F534A) + text
                           + struct.pack("<II", len(binary), 0x004E4942) + binary)


def nearest(reference, queries):
    """Index of, and distance to, the closest reference point for every query point (vectorised)."""
    import open3d as o3d
    search = o3d.core.nns.NearestNeighborSearch(o3d.core.Tensor(np.ascontiguousarray(reference, dtype=np.float64)))
    search.knn_index()
    found, squared = search.knn_search(o3d.core.Tensor(np.ascontiguousarray(queries, dtype=np.float64)), 1)
    return found.numpy()[:, 0].astype(np.int64), np.sqrt(squared.numpy()[:, 0])


def drop_small_pieces(mesh, min_triangles):
    """Removes floating fragments (dust, reflections, stray depth) smaller than min_triangles."""
    clusters, counts, _ = mesh.cluster_connected_triangles()
    clusters, counts = np.asarray(clusters), np.asarray(counts)
    small = counts[clusters] < min_triangles
    mesh.remove_triangles_by_mask(small)
    mesh.remove_unreferenced_vertices()
    return int(small.sum()), int((counts < min_triangles).sum())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-gap", type=float, default=0.12,
                        help="keep new surface only within this many metres of the scan (default 0.12; larger fills bigger holes)")
    parser.add_argument("--depth", type=int, default=10,
                        help="Poisson detail level, 9-11 (default 10, about 1-2 cm cells for a 10-20 m scan)")
    parser.add_argument("--max-triangles", type=int, default=0,
                        help="simplify the result to at most this many triangles (default: the input's count)")
    parser.add_argument("--min-piece", type=int, default=500,
                        help="remove floating pieces smaller than this many triangles (default 500; 0 keeps all)")
    args = parser.parse_args()

    import open3d as o3d

    started = time.time()
    positions, normals, colours, triangles = read_glb(args.input)
    print(f"Read {args.input.name}: {len(positions):,} vertices, {len(triangles):,} triangles")

    scan = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(positions), o3d.utility.Vector3iVector(triangles))
    if normals is None:
        scan.compute_vertex_normals()
        normals = np.asarray(scan.vertex_normals)
    # Points for Poisson: every scan vertex with its normal (facing the scanner) and colour.
    cloud = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(positions))
    cloud.normals = o3d.utility.Vector3dVector(normals)
    if colours is not None:
        cloud.colors = o3d.utility.Vector3dVector(colours)

    print(f"Poisson reconstruction (depth {args.depth})...")
    filled, _densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(cloud, depth=args.depth, scale=1.05, linear_fit=False)
    print(f"  {len(filled.vertices):,} vertices, {len(filled.triangles):,} triangles before trimming")

    # Keep only surface near the real scan: fills cracks and small holes, never invents
    # walls across doorways or open ends.
    _, distance = nearest(positions, np.asarray(filled.vertices))
    filled.remove_vertices_by_mask(distance > args.max_gap)
    filled.remove_degenerate_triangles()
    filled.remove_unreferenced_vertices()
    print(f"  {len(filled.triangles):,} triangles after trimming to {args.max_gap} m from the scan")
    if args.min_piece:
        removed, pieces = drop_small_pieces(filled, args.min_piece)
        print(f"  removed {pieces:,} floating pieces ({removed:,} triangles) under {args.min_piece} triangles")

    target = args.max_triangles or len(triangles)
    if len(filled.triangles) > target:
        print(f"Simplifying to {target:,} triangles...")
        filled = filled.simplify_quadric_decimation(target_number_of_triangles=target)
        filled.remove_unreferenced_vertices()

    # Colours from the nearest scanned point (camera sRGB, as Path Capture stores them).
    out_points = np.asarray(filled.vertices)
    found, _ = nearest(positions, out_points)
    out_colours = colours[found] if colours is not None else np.full((len(out_points), 3), 0.75)
    filled.compute_vertex_normals()
    out_normals = np.asarray(filled.vertex_normals)
    # Keep the scan's convention: normals face the side the scanner saw.
    if len(out_points) and np.mean(np.sum(out_normals * normals[found], axis=1) < 0) > 0.5:
        out_normals = -out_normals
        filled.triangles = o3d.utility.Vector3iVector(np.asarray(filled.triangles)[:, ::-1])

    write_glb(args.output, out_points, out_normals, out_colours, np.asarray(filled.triangles),
              "Path Capture (hole-filled with tools/scan_fill_holes.py)")
    size = args.output.stat().st_size / 1024 / 1024
    print(f"Wrote {args.output.name}: {len(out_points):,} vertices, {len(filled.triangles):,} triangles, "
          f"{size:.1f} MB in {time.time() - started:.0f} s")


if __name__ == "__main__":
    main()
