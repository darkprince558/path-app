"""Fuse one extracted Path Capture walk (or one legacy take) into a coloured, metric GLB."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import struct
from uuid import UUID

import numpy as np
import open3d as o3d
from PIL import Image


def read_json(path):
    return json.loads(path.read_text())


def section_folders(root):
    if (root / "walk.json").is_file():
        manifest = read_json(root / "walk.json")
        walk_id = UUID(manifest["walkID"])
        seen = set()
        for entry in sorted(manifest["sections"], key=lambda item: item["number"]):
            section_id = UUID(entry["scanID"])
            if entry["path"] != str(section_id).upper() or entry["number"] in seen:
                raise ValueError("Invalid section path or repeated section number in walk.json")
            seen.add(entry["number"])
            directory = root / entry["path"]
            record = read_json(directory / "scan.json")
            if (UUID(record["walkID"]), UUID(record["id"]), record["sectionNumber"]) != (
                    walk_id, section_id, entry["number"]):
                raise ValueError("Section belongs to a different walk or has inconsistent numbering")
            yield directory
    elif (root / "scan.json").is_file():
        yield root
    else:
        raise ValueError("Choose the extracted folder containing walk.json or scan.json")


def asset(directory, name):
    if not name or Path(name).name != name or name in (".", ".."):
        raise ValueError("Invalid frame asset name")
    return directory / name


def integrate_frame(volume, directory, frame):
    camera = frame["camera"]
    if camera["tracking"] != "normal" or not frame.get("depthMetersFloat32LE"):
        return False
    w, h = frame["depthWidth"], frame["depthHeight"]
    if not (0 < w <= 4096 and 0 < h <= 4096):
        raise ValueError("Invalid depth dimensions")
    depth = np.fromfile(asset(directory, frame["depthMetersFloat32LE"]), dtype="<f4").reshape(h, w)
    invalid = ~np.isfinite(depth) | (depth < 0.25) | (depth > 4)
    if frame.get("confidenceUInt8"):
        confidence = np.fromfile(asset(directory, frame["confidenceUInt8"]), dtype="u1").reshape(h, w)
        invalid |= (confidence < 1) | (confidence > 2)
    depth[invalid] = 0
    if not np.any(depth):
        return False
    with Image.open(asset(directory, frame["jpeg"])) as image:
        rgb = np.array(image.convert("RGB").resize((w, h), Image.Resampling.BILINEAR))
    k = np.asarray(camera["intrinsics"]).reshape(3, 3, order="F")
    sx, sy = w / camera["imageWidth"], h / camera["imageHeight"]
    intrinsic = o3d.camera.PinholeCameraIntrinsic(w, h, k[0, 0]*sx, k[1, 1]*sy, k[0, 2]*sx, k[1, 2]*sy)
    world_from_ar = np.asarray(camera["cameraToWorld"]).reshape(4, 4, order="F")
    if not np.isfinite(world_from_ar).all() or not np.isfinite(k).all() or min(k[0,0], k[1,1]) <= 0:
        raise ValueError("Invalid saved camera calibration")
    # ARKit camera +Y up, -Z forward; Open3D depth camera +Y down, +Z forward.
    depth_from_world = np.diag([1., -1., -1., 1.]) @ np.linalg.inv(world_from_ar)
    rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
        o3d.geometry.Image(rgb), o3d.geometry.Image(depth), depth_scale=1.0,
        depth_trunc=4.01, convert_rgb_to_intensity=False)
    volume.integrate(rgbd, intrinsic, depth_from_world)
    return True


def write_glb(path, mesh):
    """Write a self-contained, four-byte-aligned glTF with metric vertex positions."""
    positions = np.asarray(mesh.vertices, dtype="<f4")
    normals = np.asarray(mesh.vertex_normals, dtype="<f4")
    rgb = np.clip(np.asarray(mesh.vertex_colors), 0, 1)
    linear = np.where(rgb <= .04045, rgb/12.92, ((rgb+.055)/1.055)**2.4)
    rgba = np.column_stack((np.rint(linear*255), np.full(len(rgb),255))).astype("u1")
    indices = np.asarray(mesh.triangles, dtype="<u4").reshape(-1)
    arrays = (positions, normals, rgba, indices)
    views, accessors, offset = [], [], 0
    for i, (array, kind, components) in enumerate(zip(arrays, ("VEC3","VEC3","VEC4","SCALAR"),
                                                      (5126,5126,5121,5125))):
        views.append({"buffer":0, "byteOffset":offset, "byteLength":array.nbytes})
        accessors.append({"bufferView":i, "componentType":components, "count":len(array), "type":kind})
        offset += array.nbytes
    accessors[0].update(min=positions.min(axis=0).tolist(), max=positions.max(axis=0).tolist())
    accessors[2]["normalized"] = True
    doc = {"asset":{"version":"2.0","generator":"Path Capture depth fusion"}, "scene":0,
           "scenes":[{"nodes":[0]}], "nodes":[{"mesh":0}], "buffers":[{"byteLength":offset}],
           "bufferViews":views, "accessors":accessors,
           "materials":[{"doubleSided":True,"pbrMetallicRoughness":{"metallicFactor":0,"roughnessFactor":1}}],
           "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1,"COLOR_0":2},
                                     "indices":3,"material":0}]}]}
    description = json.dumps(doc,separators=(",",":")).encode()
    description += b" " * (-len(description) % 4)
    with path.open("xb") as out:
        out.write(struct.pack("<4sII", b"glTF", 2, 28 + len(description) + offset))
        out.write(struct.pack("<I4s",len(description),b"JSON"))
        out.write(description)
        out.write(struct.pack("<I4s",offset,b"BIN\0"))
        for array in arrays:
            out.write(np.ascontiguousarray(array).tobytes())


def reconstruct(root, destination, voxel=0.04):
    if destination.suffix.lower() != ".glb" or destination.exists():
        raise ValueError("Choose a new .glb output filename")
    if not 0.01 <= voxel <= 0.2:
        raise ValueError("Voxel width must be between 0.01 and 0.20 metres")
    volume = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=voxel, sdf_trunc=voxel*4, color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8)
    used, skipped = 0, 0
    missing = []
    for section in section_folders(root):
        keys = section / "keyframes.json"
        count = 0
        if keys.is_file():
            for frame in read_json(keys):
                if integrate_frame(volume, section, frame): count += 1
                else: skipped += 1
        if count == 0:
            missing.append(section.name)
        print(f"{section.name}: {count} depth frames integrated", flush=True)
        used += count
    if missing:
        print("Partial walk: no usable depth for " + ", ".join(missing), flush=True)
    mesh = volume.extract_triangle_mesh()
    if not len(mesh.triangles):
        raise ValueError("No surface recovered. This reconstruction needs tracked RGB and metric depth.")
    mesh.compute_vertex_normals()
    # Same-volume link publishes only a complete new file and preserves existing outputs.
    with tempfile.TemporaryDirectory(dir=destination.parent) as tmp:
        staged = Path(tmp) / "scene.glb"
        write_glb(staged, mesh)
        os.link(staged, destination)
    print(f"{used} frames integrated, {skipped} skipped, {len(mesh.triangles):,} triangles → {destination}")
    return mesh


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--voxel", type=float, default=0.04, help="voxel width in metres (default 0.04)")
    parser.add_argument("--view", action="store_true", help="open the derived mesh on this Mac")
    args = parser.parse_args()
    try:
        model = reconstruct(args.capture, args.output, args.voxel)
        if args.view:
            o3d.visualization.draw_geometries([model], window_name="Path Capture · hallway", mesh_show_back_face=True)
    except (OSError, ValueError, KeyError, RuntimeError) as exc:
        parser.exit(1, f"Reconstruction failed: {exc}\n")
