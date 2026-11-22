#!/usr/bin/env python3
"""Writes a small synthetic room GLB shaped like Path Capture's export (ScanGeometry.swift):
vertex colours (COLOR_0), an unlit double-sided material, and ARKit's per-vertex
_AR_CLASSIFICATION (VEC4 unsigned bytes, first byte = 0 none, 1 wall, 2 floor, 3 ceiling,
7 door). Used to check how the viewer draws floors, walls and ceilings. Metres, +Y up."""

import json
import struct
import sys
from pathlib import Path

W, D, H = 6.0, 4.0, 2.5          # room width (x), depth (z), height (y)
DOOR_X, DOOR_W, DOOR_H = 1.0, 1.0, 2.1  # doorway in the front wall (z = D/2)
COLORS = {1: (226, 216, 190), 2: (150, 120, 86), 3: (205, 205, 200), 7: (196, 120, 70)}

verts, colors, classes, indices = [], [], [], []


def quad(a, b, c, d, label):
    """Two triangles a-b-c, a-c-d with one ARKit class."""
    start = len(verts)
    for p in (a, b, c, d):
        verts.append(p)
        colors.append(COLORS[label] + (255,))
        classes.append((label, 0, 0, 0))
    indices.extend([start, start + 1, start + 2, start, start + 2, start + 3])


x0, x1, z0, z1 = -W / 2, W / 2, -D / 2, D / 2
quad((x0, 0, z0), (x1, 0, z0), (x1, 0, z1), (x0, 0, z1), 2)          # floor
quad((x0, H, z1), (x1, H, z1), (x1, H, z0), (x0, H, z0), 3)          # ceiling
quad((x0, 0, z0), (x0, H, z0), (x1, H, z0), (x1, 0, z0), 1)          # back wall
quad((x0, 0, z1), (x0, H, z1), (x0, H, z0), (x0, 0, z0), 1)          # left wall
quad((x1, 0, z0), (x1, H, z0), (x1, H, z1), (x1, 0, z1), 1)          # right wall
dl, dr = DOOR_X - DOOR_W / 2, DOOR_X + DOOR_W / 2                     # front wall around a doorway
quad((x0, 0, z1), (dl, 0, z1), (dl, H, z1), (x0, H, z1), 1)
quad((dr, 0, z1), (x1, 0, z1), (x1, H, z1), (dr, H, z1), 1)
quad((dl, DOOR_H, z1), (dr, DOOR_H, z1), (dr, H, z1), (dl, H, z1), 1)
quad((-1.5, 0.0, z0 + 0.02), (-0.6, 0.0, z0 + 0.02), (-0.6, 2.0, z0 + 0.02), (-1.5, 2.0, z0 + 0.02), 7)  # a door on the back wall

pos = b"".join(struct.pack("<3f", *p) for p in verts)
col = b"".join(struct.pack("<4B", *c) for c in colors)
cls = b"".join(struct.pack("<4B", *c) for c in classes)
idx = b"".join(struct.pack("<I", i) for i in indices)
chunks, views, offset = [], [], 0
for data in (pos, col, cls, idx):
    views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data)})
    chunks.append(data + b"\0" * (-len(data) % 4))
    offset += len(chunks[-1])
binary = b"".join(chunks)
xs, ys, zs = zip(*verts)
gltf = {
    "asset": {"version": "2.0", "generator": "Path Capture (synthetic test room, tools/make_classified_room.py)"},
    "extensionsUsed": ["KHR_materials_unlit"],
    "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
    "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "COLOR_0": 1, "_AR_CLASSIFICATION": 2},
                                "indices": 3, "material": 0, "mode": 4}],
                "extras": {"classificationNames": ["unclassified", "wall", "floor", "ceiling", "table", "seat", "window", "door"]}}],
    "materials": [{"pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1}, "doubleSided": True,
                   "extensions": {"KHR_materials_unlit": {}}}],
    "buffers": [{"byteLength": len(binary)}],
    "bufferViews": views,
    "accessors": [
        {"bufferView": 0, "componentType": 5126, "count": len(verts), "type": "VEC3",
         "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
        {"bufferView": 1, "componentType": 5121, "normalized": True, "count": len(verts), "type": "VEC4"},
        {"bufferView": 2, "componentType": 5121, "count": len(verts), "type": "VEC4"},
        {"bufferView": 3, "componentType": 5125, "count": len(indices), "type": "SCALAR"},
    ],
}
text = json.dumps(gltf, separators=(",", ":")).encode()
text += b" " * (-len(text) % 4)
glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(binary))
glb += struct.pack("<II", len(text), 0x4E4F534A) + text + struct.pack("<II", len(binary), 0x004E4942) + binary
out = Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures/venue/classified-room.glb")
out.write_bytes(glb)
print(f"Wrote {out} ({len(glb)} bytes, {len(indices) // 3} triangles)")
