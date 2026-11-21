"""Make a textured GLB and matching cleaned point cloud from a saved OpenMVS run."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import numpy as np


def check_tools(bin_dir):
    try:
        import cloud_cleanup
        import mesh_geometry
        from mesh_native import resolve_tools
    except ImportError as exc:
        raise RuntimeError(f"Missing mesh dependency ({exc}). Run ./hallway3d setup-openmvs.") from exc
    resolve_tools(bin_dir)


def saved_scene(run):
    path = run / "report.json"
    if not path.is_file():
        raise ValueError("Choose a reconstruction run containing report.json and its openmvs directory.")
    report = json.loads(path.read_text())
    if not isinstance(report, dict) or report.get("status") != "ready":
        raise ValueError("The selected reconstruction has no completed capture report.")
    folder = run / "openmvs"
    for name in ("dense.mvs", "dense.ply"):
        if not (folder / name).is_file():
            raise ValueError(f"Missing openmvs/{name}. Use a run made with --surface openmvs or compare.")
    if not (folder / "colmap/images").is_dir():
        raise ValueError("The saved OpenMVS scene is missing its undistorted camera images.")
    try:
        transform = np.asarray(report.get("world_to_view"), dtype=np.float64)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("The saved world_to_view transform must contain numeric coordinates.") from exc
    if transform.shape != (4, 4) or not np.isfinite(transform).all():
        raise ValueError("The saved world_to_view transform must be a finite 4 by 4 matrix.")
    rotation = transform[:3, :3]
    if (not np.allclose(transform[3], [0, 0, 0, 1])
            or not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-5)
            or not np.isclose(np.linalg.det(rotation), 1, atol=1e-5)):
        raise ValueError("The saved world_to_view transform must be a rotation and translation.")
    return report, transform


def build(run, output, bin_dir=None):
    source, transform = saved_scene(run)
    check_tools(bin_dir)
    from cloud_cleanup import clean_cloud
    from mesh_geometry import clean_mesh, export_glb
    from mesh_native import reconstruct, texture

    try:
        output.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise ValueError(f"Mesh output already exists at {output}. Choose a new --output directory.") from exc
    dense = run / "openmvs"
    original = dense / "dense.ply"
    points, glb = output / "points.ply", output / "hallway.glb"
    start = time.monotonic()
    report = {"status": "processing", "source_report": os.path.relpath(run / "report.json", output),
              "axes": source.get("axes"), "units": source.get("units", "arbitrary"),
              "world_to_view": transform.tolist(), "camera_views": source.get("camera_views", [])}
    try:
        print("1/4  Removing isolated samples from the full OpenMVS cloud", flush=True)
        report["point_cleanup"] = clean_cloud(original, transform, points)
        print("2/4  Reconstructing triangles using the saved OpenMVS camera visibility", flush=True)
        raw, report["reconstruction"] = reconstruct(dense, output / "reconstruction", bin_dir=bin_dir)
        print("3/4  Cleaning triangle islands and checking support against the dense samples", flush=True)
        cleaned = output / "cleaned-mesh.ply"
        report["mesh_cleanup"] = clean_mesh(raw, original, cleaned)
        print("4/4  Baking the camera images into a textured GLB", flush=True)
        textured, report["texturing"] = texture(dense, cleaned, output / "texture", bin_dir=bin_dir)
        report["glb"] = export_glb(textured, transform, glb)
        report["exports"] = {"points": {"file": points.name, "bytes": points.stat().st_size},
                             "mesh": {"file": glb.name, "bytes": glb.stat().st_size}}
        report["status"] = "ready"
    except Exception as exc:
        report.update(status="failed", error=str(exc))
        raise
    except KeyboardInterrupt:
        report["status"] = "interrupted"
        raise
    finally:
        report["elapsed_seconds"] = round(time.monotonic() - start, 2)
        pending = output / "report.json.partial"
        pending.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        pending.replace(output / "report.json")
    print(f"Cleaned point cloud: {points}\nTextured mesh: {glb}\nMesh report: {output / 'report.json'}",
          flush=True)
    return points, glb


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="completed reconstruction run containing openmvs/dense.mvs")
    parser.add_argument("--output", type=Path, help="new output directory (default: RUN/mesh)")
    parser.add_argument("--openmvs-bin", type=Path, help="directory containing ReconstructMesh and TextureMesh")
    parser.add_argument("--no-preview", action="store_true")
    parser.add_argument("--port", type=int, default=0, help="local comparison viewer port (default: automatic)")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    run = args.run.expanduser().resolve()
    output = args.output.expanduser().resolve() if args.output else run / "mesh"
    try:
        points, glb = build(run, output, args.openmvs_bin)
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as exc:
        parser.exit(1, f"Mesh reconstruction failed: {exc}\n")
    if args.no_preview:
        return 0
    return subprocess.call([sys.executable, str(Path(__file__).with_name("preview.py")), str(points),
                            "--mesh", str(glb), "--report", str(output / "report.json"), "--port", str(args.port)])


if __name__ == "__main__":
    sys.exit(main())
