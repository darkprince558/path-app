"""Reconstruct a visibility-supported mesh and texture it from the saved camera views."""

import os
from pathlib import Path
import re
import time

from openmvs import _run, _tool


def resolve_tools(bin_dir=None):
    directory = bin_dir if bin_dir is not None else os.environ.get("OPENMVS_BIN")
    return _tool("ReconstructMesh", directory), _tool("TextureMesh", directory)


def _prepare(run_mvs_dir, work_dir):
    source = Path(run_mvs_dir).resolve()
    if not (source / "dense.mvs").is_file() or not (source / "colmap/images").is_dir():
        raise ValueError("Expected an OpenMVS dense.mvs archive and its undistorted colmap/images directory.")
    work = Path(work_dir).resolve()
    work.mkdir(parents=True, exist_ok=False)
    # The camera archive stores image names relative to OpenMVS's working directory.
    # Preserve those names while directing all generated files into the new run.
    (work / "colmap").symlink_to(source / "colmap", target_is_directory=True)
    return source, work


def _stats(log, artifact, start):
    if not artifact.is_file() or artifact.stat().st_size == 0:
        raise RuntimeError(f"OpenMVS did not write {artifact.name}. See {log}")
    text = log.read_text(errors="replace")
    version = re.search(r"OpenMVS[^\n]*?\bv([0-9]+(?:\.[0-9]+)+)", text)
    stats = {"version": version.group(1) if version else "unknown", "bytes": artifact.stat().st_size,
             "elapsed_seconds": round(time.monotonic() - start, 2)}
    saved = re.search(r"Mesh '[^'\n]+' saved: (\d+) vertices, (\d+) faces", text)
    if saved:
        stats.update(vertices=int(saved.group(1)), faces=int(saved.group(2)))
    atlas = re.search(r"atlas and image completed: (\d+) patches, (\d+) image size, (\d+) textures", text)
    if atlas:
        stats.update(texture_patches=int(atlas.group(1)), atlas_edge_pixels=int(atlas.group(2)),
                     texture_atlases=int(atlas.group(3)))
    return stats


def reconstruct(run_mvs_dir, work_dir, *, bin_dir=None):
    """Triangulate the original fused samples using the camera visibility in dense.mvs."""
    binary, _ = resolve_tools(bin_dir)
    source, work = _prepare(run_mvs_dir, work_dir)
    start = time.monotonic()
    threads = min(os.cpu_count() or 1, 7)
    # Archive type 1 keeps the per-sample view lists from dense.mvs. OpenMVS's
    # default instead opens the adjacent scalar RGB PLY, which has no visibility.
    log = _run(binary, [
        "-i", str(source / "dense.mvs"), "-o", "mesh.mvs", "--archive-type", "1",
        "--export-type", "ply", "--target-face-num", "220000", "--min-point-distance", "2",
        "--remove-spurious", "20", "--remove-spikes", "1", "--close-holes", "0",
        "--smooth", "1", "--crop-to-roi", "0", "--max-threads", str(threads),
    ], work)
    result = work / "mesh.ply"
    return result, _stats(log, result, start)


def texture(run_mvs_dir, cleaned_mesh_path, work_dir, *, bin_dir=None):
    """Project the calibrated photographs onto the cleaned mesh in native coordinates."""
    _, binary = resolve_tools(bin_dir)
    mesh = Path(cleaned_mesh_path).resolve()
    if not mesh.is_file():
        raise ValueError(f"Missing cleaned triangle mesh: {mesh}")
    source, work = _prepare(run_mvs_dir, work_dir)
    start = time.monotonic()
    threads = min(os.cpu_count() or 1, 7)
    # The original camera interface contains every calibrated image. Reading it
    # avoids writing a redundant archive of the dense points and unpacked atlas.
    camera_scene = source / "scene.mvs"
    if not camera_scene.is_file():
        camera_scene = source / "dense.mvs"
    # Native global leveling can abort on open patch boundaries, and local
    # leveling distorted the measured hallway colors. Keep the camera colors.
    log = _run(binary, [
        "-i", str(camera_scene), "-m", str(mesh), "-o", "textured.glb",
        "--export-type", "glb", "--close-holes", "0",
        "--resolution-level", "0", "--max-texture-size", "4096",
        "--global-seam-leveling", "0", "--local-seam-leveling", "0",
        "--empty-color", "8421504", "--max-threads", str(threads),
    ], work)
    result = work / "textured.glb"
    return result, _stats(log, result, start)
