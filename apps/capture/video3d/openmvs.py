"""Fuse undistorted RGB views from the selected COLMAP model using OpenMVS on CPU."""

import os
import re
from pathlib import Path
import shutil
import subprocess
import time

import numpy as np
import pycolmap


LOCAL_BIN = Path(__file__).resolve().parents[3] / "captures-local/video3d-tools/openmvs/env/bin"
# Bound the in-memory copy. The untouched full-density result stays on disk.
MAX_CANDIDATES = 2_000_000
PLY_TYPES = {
    "float": "f4", "float32": "f4", "double": "f8", "float64": "f8",
    "uchar": "u1", "uint8": "u1", "char": "i1", "int8": "i1",
    "ushort": "<u2", "uint16": "<u2", "short": "<i2", "int16": "<i2",
    "uint": "<u4", "uint32": "<u4", "int": "<i4", "int32": "<i4",
}


def _tool(name, directory):
    if directory is not None:
        path = shutil.which(str(Path(directory).expanduser().resolve() / name))
    else:
        path = shutil.which(str(LOCAL_BIN / name)) or shutil.which(name)
    if path is None:
        raise RuntimeError(
            f"Missing OpenMVS executable {name}. Run ./hallway3d setup-openmvs "
            "or set OPENMVS_BIN to the directory containing both executables."
        )
    return path


def resolve_tools(bin_dir=None):
    directory = bin_dir if bin_dir is not None else os.environ.get("OPENMVS_BIN")
    return _tool("InterfaceCOLMAP", directory), _tool("DensifyPointCloud", directory)


def _run(binary, args, work):
    log = work / (Path(binary).name + ".log")
    with log.open("wb") as output:
        result = subprocess.run([binary, *args], cwd=work, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"{Path(binary).name} exited with status {result.returncode}. See {log}")
    return log


def _read_cloud(path, world_to_view):
    """Read OpenMVS's scalar vertex PLY, allowing extra fields such as normals."""
    with path.open("rb") as stream:
        if stream.readline().strip() != b"ply" or stream.readline().strip() != b"format binary_little_endian 1.0":
            raise ValueError(f"Expected a binary little-endian OpenMVS PLY in {path}")
        count = None
        fields = []
        in_vertices = False
        while stream.tell() < 65536:
            words = stream.readline(4096).decode("ascii").split()
            if not words:
                raise ValueError(f"Incomplete OpenMVS PLY header in {path}")
            if words[0] == "end_header":
                break
            if words[0] == "element":
                if len(words) != 3:
                    raise ValueError(f"Invalid OpenMVS element declaration in {path}")
                in_vertices = words[1] == "vertex"
                if count is None and not in_vertices:
                    raise ValueError(f"Expected vertices first in {path}")
                if in_vertices:
                    count = int(words[2])
            elif in_vertices and words[0] == "property":
                if len(words) != 3 or words[1] not in PLY_TYPES:
                    raise ValueError(f"Unsupported OpenMVS vertex property in {path}: {' '.join(words)}")
                fields.append((words[2], PLY_TYPES[words[1]]))
        else:
            raise ValueError(f"Missing end of OpenMVS PLY header in {path}")
        offset = stream.tell()
    dtype = np.dtype(fields).newbyteorder("<")
    required = {"x", "y", "z", "red", "green", "blue"}
    if not count or count < 0 or not required.issubset(dtype.names or ()):
        raise ValueError(f"OpenMVS produced no colored vertices in {path}")
    if any(dtype.fields[key][0] != np.dtype("uint8") for key in ("red", "green", "blue")):
        raise ValueError(f"Expected byte RGB colors in {path}")
    if path.stat().st_size - offset < count * dtype.itemsize:
        raise ValueError(f"Truncated OpenMVS vertex data in {path}")
    vertices = np.memmap(path, dtype=dtype, mode="r", offset=offset, shape=(count,))
    if count > MAX_CANDIDATES:
        vertices = vertices[np.linspace(0, count - 1, MAX_CANDIDATES, dtype=np.int64)]
    xyz = np.column_stack([vertices[key] for key in ("x", "y", "z")])
    rgb = np.column_stack([vertices[key] for key in ("red", "green", "blue")])
    transform = np.asarray(world_to_view, dtype=np.float64)
    xyz = (xyz @ transform[:3, :3].T + transform[:3, 3]).astype(np.float32)
    finite = np.isfinite(xyz).all(axis=1)
    if not finite.any():
        raise ValueError("None of the fused OpenMVS coordinates are finite.")
    return xyz[finite], rgb[finite], count


def dense_points(model, frames, world_to_view, work, *, bin_dir=None):
    """Return RGB and viewer-space positions using exactly the supplied camera model."""
    importer, densifier = resolve_tools(bin_dir)
    work = Path(work).resolve()
    work.mkdir(parents=True, exist_ok=False)
    # CUDA builds expose --cuda-device -2 to request CPU; CPU-only builds omit the flag.
    help_text = subprocess.run(
        [densifier, "--help"], cwd=work, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, errors="replace",
    ).stdout
    cpu_args = ["--cuda-device", "-2"] if "--cuda-device" in help_text else []
    version = re.search(r"OpenMVS[^\n]*?\bv([0-9]+(?:\.[0-9]+)+)", help_text)
    threads = min(os.cpu_count() or 1, 7)
    start = time.monotonic()
    input_model = work / "original"
    input_model.mkdir()
    model.write(input_model)
    # OpenMVS's COLMAP importer requires pinhole images. Undistortion preserves
    # camera poses and sparse point coordinates in the supplied reconstruction.
    pycolmap.undistort_images(
        output_path=work / "colmap", input_path=input_model, image_path=Path(frames).resolve(),
        num_threads=threads, undistort_options=pycolmap.UndistortCameraOptions(max_image_size=800),
        jpeg_quality=95,
    )
    _run(importer, ["-i", "colmap", "-o", "scene.mvs"], work)
    # Require three agreeing images per fused point. Disable the optional tower
    # prior and ROI crop, keeping the original scale and the full hallway extent.
    # Archive type 1 exports scalar XYZ, RGB and normals to PLY; the default
    # interface archive additionally writes variable-length per-point view lists.
    log = _run(densifier, [
        "-i", "scene.mvs", "-o", "dense.mvs", "--archive-type", "1",
        "--resolution-level", "0", "--max-resolution", "800", "--min-resolution", "320",
        "--number-views", "4", "--number-views-fuse", "3", "--estimate-colors", "2",
        "--tower-mode", "0", "--crop-to-roi", "0", "--estimate-roi", "0",
        "--remove-dmaps", "1", "--max-threads", str(threads), *cpu_args,
    ], work)
    cloud = work / "dense.ply"
    if not cloud.is_file():
        raise RuntimeError(f"OpenMVS finished without a dense point cloud. See {log}")
    positions, colors, count = _read_cloud(cloud, world_to_view)
    return positions, colors, {
        "backend": "OpenMVS CPU", "version": version.group(1) if version else "unknown",
        "input_registered_frames": model.num_reg_images(),
        "input_sparse_points": model.num_points3D(), "raw_fused_points": count,
        "dense_points": len(positions), "max_image_size": 800, "neighbor_views": 4,
        "minimum_fusion_views": 3, "threads": threads,
        "elapsed_seconds": round(time.monotonic() - start, 2),
    }
