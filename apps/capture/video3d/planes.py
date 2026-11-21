"""Test supported wall and floor fills against the photographs of a saved hallway."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
import pycolmap

from mesh import saved_scene
from plane_views import ordered_poses
from reconstruct import capture_view


def capture_path(run, transform, fps, focus_time, turn=None):
    model = pycolmap.Reconstruction(run / "openmvs/colmap/sparse")
    images = ordered_poses(model)
    if not images or not np.isfinite(fps) or fps <= 0:
        raise ValueError("The run needs calibrated camera poses and a positive sampling rate.")
    times = np.array([(int(Path(im.name).stem.split("-")[-1]) - 1) / fps for im in images])
    positions = np.array([im.projection_center() for im in images]) @ transform[:3, :3].T + transform[:3, 3]
    support = np.array([im.num_points3D >= 20 for im in images])
    centers = positions[support] if support.any() else positions
    distance = max(.16 * np.linalg.norm(np.ptp(centers, axis=0)), .01)
    if focus_time is None:
        focus_time = float(np.median(times))
    elif focus_time < 0 or focus_time > times[-1] + 1 / fps or not np.isfinite(focus_time):
        raise ValueError(f"--focus-time must be within the recording (0–{times[-1]:g} seconds).")
    def nearest(t):
        return int(np.argmin(np.abs(times - t)))
    selected = [nearest(focus_time)]
    # Offer every calibrated viewpoint inside the requested turn and a short list elsewhere.
    spacing = max(.5, (times[-1] - times[0]) / 35)
    regular = (nearest(t) for t in np.arange(times[0], times[-1] + spacing, spacing))
    turn_indices = [] if turn is None else np.flatnonzero((times >= turn[0]) & (times <= turn[1]))
    indices = dict.fromkeys(selected + sorted(set(regular).union(np.flatnonzero(~support), turn_indices)))
    views = []
    for i in indices:
        view = capture_view(images[i], transform, fps, distance)
        view["label"] = f"{times[i]:g} s" + ("" if support[i] else " · weak pose")
        views.append(view)
    landmarks = np.array([p.xyz for p in model.points3D.values()
                          if p.track.length() >= 4 and p.error <= 1.8], dtype=np.float64).reshape(-1, 3)
    sparse = landmarks @ transform[:3, :3].T + transform[:3, 3]
    return centers, views, sparse[np.isfinite(sparse).all(axis=1)]


def checked_subset(indices, keep, label):
    keep = np.asarray(keep)
    if keep.dtype != bool or keep.shape != indices.shape:
        raise ValueError(f"{label} returned an invalid visibility mask.")
    return indices[keep]


def build(run, output, focus_time=None, turn=None, depth_cache=None, bin_dir=None):
    try:
        from plane_fit import propose
        from plane_glb import merge
        from plane_photo import verify_and_texture
    except ImportError as error:
        raise RuntimeError(f"Missing plane-fitting dependency ({error}). Run ./hallway3d setup-openmvs.") from error
    source, transform = saved_scene(run)
    mesh = run / "mesh"
    base, points = mesh / "hallway.glb", mesh / "points.ply"
    if not all(p.is_file() for p in (base, points, mesh / "report.json")):
        raise ValueError("Build the baseline first with ./hallway3d mesh RUN.")
    base_report = json.loads((mesh / "report.json").read_text())
    if base_report.get("status") != "ready" or not np.array_equal(base_report.get("world_to_view"), transform):
        raise ValueError("The baseline mesh and camera run must share a completed reconstruction frame.")
    if turn is not None:
        start_s, end_s = turn
        if (not np.isfinite(turn).all() or start_s < 0 or end_s <= start_s
                or end_s > source["video"]["duration_seconds"]):
            raise ValueError("--turn needs a start and end time within the video.")
        if focus_time is None:
            focus_time = .5 * (start_s + end_s)
    fps = source["video"]["sample_fps"]
    centers, views, landmarks = capture_path(run, transform, fps, focus_time, turn)
    try:
        output.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise ValueError(f"Output already exists at {output}. Choose a new --output directory.") from exc
    start = time.monotonic()
    combined, fills = output / "hallway-planes.glb", output / "fills.glb"
    report = {"status": "processing", "baseline": os.path.relpath(base, output),
              "world_to_view": transform.tolist(), "units": source.get("units", "arbitrary"),
              "axes": source.get("axes"), "camera_views": views}
    try:
        extra = None
        cache = depth_cache or run / "plane-depth-cache"
        if turn is not None:
            from plane_sweep_depth import sweep_anchors
            from plane_depth_anchors import get_turn_anchors
            print(f"Checking depth from neighboring viewpoints in {start_s:g}–{end_s:g} s", flush=True)
            stereo_xyz, report["depth_sweep"] = sweep_anchors(run, start_s, end_s)
            native_xyz, report["native_anchors"] = get_turn_anchors(run, cache, start_s, end_s, bin_dir=bin_dir)
            extra = np.vstack((stereo_xyz, native_xyz))
            report["turn_seconds"] = list(turn)
        print("1/4  Finding bounded gaps in locally supported planes", flush=True)
        vertices, faces, ids, planes, report["geometry"] = propose(
            points, base, centers, sparse_points=landmarks, corroborating_points=extra)
        candidates = np.arange(len(faces), dtype=np.int64)
        if len(candidates):
            from plane_observations import reject_occlusions
            from plane_native_depth import prepare_and_veto
            print(f"2/4  Checking {len(faces):,} proposed faces against observed features and depth", flush=True)
            keep, report["observation_rays"] = reject_occlusions(run, base, vertices, faces)
            candidates = checked_subset(candidates, keep, "Feature ray check")
            if len(candidates):
                keep, report["native_depth"] = prepare_and_veto(run, cache, vertices, faces[candidates], bin_dir=bin_dir)
                candidates = checked_subset(candidates, keep, "OpenMVS depth check")
        if len(candidates):
            print(f"3/4  Comparing {len(candidates):,} surviving faces across photographs", flush=True)
            accepted, report["photometry"] = verify_and_texture(
                run, vertices, faces[candidates], ids[candidates], fills, turn=turn)
        else:
            accepted, report["photometry"] = [], {"reason": "No supported gaps left for texturing."}
        accepted = np.asarray(accepted, dtype=np.int64)
        if (accepted.ndim != 1 or len(np.unique(accepted)) != len(accepted)
                or np.any((accepted < 0) | (accepted >= len(candidates)))):
            raise ValueError("Photo verification returned invalid face indices.")
        accepted = candidates[accepted]
        plane_ids = np.asarray(ids)
        accepted_ids, counts = np.unique(plane_ids[accepted], return_counts=True)
        accepted_counts = dict(zip(accepted_ids.tolist(), counts.tolist()))
        report["planes"] = [dict(p, accepted_faces=accepted_counts.get(p["id"], 0)) for p in planes]
        report["proposed_faces"], report["accepted_faces"] = len(faces), len(accepted)
        print(f"4/4  Packaging {len(accepted):,} supported faces with the original mesh", flush=True)
        report["merge"] = merge(base, fills if len(accepted) else None, combined)
        report["export"] = combined.name
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
    print(f"Baseline: {base}\nPlane comparison: {combined}\nReport: {output / 'report.json'}", flush=True)
    return base, combined


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="existing reconstruction containing mesh/hallway.glb")
    parser.add_argument("--output", type=Path, help="new output directory (default: RUN/planes)")
    parser.add_argument("--focus-time", type=float, help="initial comparison viewpoint in video seconds")
    parser.add_argument("--turn", type=float, nargs=2, metavar=("START", "END"),
                        help="also check depth from neighboring views during this video interval in seconds")
    parser.add_argument("--depth-cache", type=Path, help="directory for camera-specific OpenMVS depth maps (default: RUN/plane-depth-cache)")
    parser.add_argument("--openmvs-bin", type=Path, help="directory containing the OpenMVS executables")
    parser.add_argument("--no-preview", action="store_true")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    run = args.run.expanduser().resolve()
    output = args.output.expanduser().resolve() if args.output else run / "planes"
    try:
        cache = args.depth_cache.expanduser().resolve() if args.depth_cache else None
        base, enhanced = build(run, output, args.focus_time, args.turn, cache, args.openmvs_bin)
    except (ValueError, OSError, RuntimeError) as error:
        parser.exit(1, f"Plane reconstruction failed: {error}\n")
    if args.no_preview:
        return 0
    return subprocess.call([sys.executable, str(Path(__file__).with_name("preview.py")), str(base),
                            "--planes", str(enhanced), "--report", str(output / "report.json"), "--port", str(args.port)])


if __name__ == "__main__":
    sys.exit(main())
