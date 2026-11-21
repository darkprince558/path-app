"""Reconstruct one continuous phone video on the Mac and preview its RGB point cloud."""

import argparse
from datetime import datetime
from fractions import Fraction
from itertools import groupby
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import cv2
import numpy as np
import pycolmap

from sparse import reconstruct, sparse_points


ROOT = Path(__file__).resolve().parents[3]
RUNS = ROOT / "captures-local" / "runs"
MAX_RENDER_POINTS = 600_000  # Guest viewer's full-resolution point budget.


def extract_frames(video, directory, fps, limit):
    stream_info = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "V:0", "-show_entries",
        "stream=index,codec_name,width,height,duration,avg_frame_rate,color_transfer:"
        "stream_side_data=rotation:format=duration", "-of", "json", str(video),
    ], text=True)
    info = json.loads(stream_info)
    if not info["streams"]:
        raise ValueError("This file has no video track.")
    stream = info["streams"][0]
    duration = float(stream.get("duration") or info["format"].get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Video duration is missing. Export the original clip as MOV or MP4.")
    rate = min(fps, limit / duration)
    source_rate = stream.get("avg_frame_rate", "0/0")
    if source_rate != "0/0" and Fraction(source_rate) > 0:
        rate = min(rate, float(Fraction(source_rate)))
    # JPEG decoders assume full-range BT.601 YCbCr, including for HDR inputs.
    scale = ("scale=w='min(iw,1280)':h='min(ih,1280)':"
             "force_original_aspect_ratio=decrease:force_divisible_by=2")
    transfer = stream.get("color_transfer")
    if transfer in ("arib-std-b67", "smpte2084"):
        # FFmpeg 9's swscale can tone-map HLG/PQ to the SDR colors of the viewer.
        scale += ":out_primaries=bt709:out_transfer=iec61966-2-1:intent=perceptual"
    scale += ",format=rgb24,scale=out_color_matrix=bt601:out_range=full"
    directory.mkdir()
    subprocess.run([
        "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(video),
        "-map", f"0:{stream['index']}", "-an", "-sn", "-dn", "-map_metadata", "-1",
        "-vf", f"fps={rate:.10f},{scale},setsar=1", "-frames:v", str(limit),
        "-q:v", "2", "-pix_fmt", "yuvj444p", str(directory / "frame-%06d.jpg"),
    ], check=True)
    files = sorted(directory.glob("*.jpg"))
    if len(files) < 4:
        raise ValueError(f"Only {len(files)} frames sampled. Use a longer clip with camera movement.")
    first = cv2.imread(str(files[0]))
    if first is None:
        raise ValueError("The first sampled image could not be decoded.")
    height, width = first.shape[:2]
    return {
        "duration_seconds": duration, "stream": stream, "sample_fps": rate,
        "sampled_frames": len(files), "sample_width": width, "sample_height": height,
        "color_conversion": "HDR to SDR" if transfer in ("arib-std-b67", "smpte2084") else "SDR JPEG",
    }


def write_cloud(path, xyz, rgb):
    # A single mis-triangulated point can make the viewer zoom out beyond the hall.
    # Keep a generous margin around the middle 98% along each axis.
    low, high = np.percentile(xyz, [1, 99], axis=0)
    margin = np.maximum(high - low, np.finfo(float).eps) * 0.5
    keep = np.all((xyz >= low - margin) & (xyz <= high + margin), axis=1)
    positions, colors = xyz[keep], rgb[keep]
    if not len(positions):
        raise ValueError("No finite geometry survived the preview bounds check.")
    if len(positions) > MAX_RENDER_POINTS:
        indices = np.linspace(0, len(positions) - 1, MAX_RENDER_POINTS, dtype=int)
        positions, colors = positions[indices], colors[indices]
    vertices = np.empty(len(positions), dtype=[("xyz", "<f4", (3,)), ("rgb", "u1", (3,))])
    vertices["xyz"], vertices["rgb"] = positions, colors
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        "comment Path App video reconstruction; arbitrary scale\n"
        f"element vertex {len(vertices)}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
    )
    pending = path.with_suffix(".partial")
    with pending.open("xb") as out:
        out.write(header.encode("ascii"))
        vertices.tofile(out)
    pending.rename(path)
    return {"points": len(vertices), "bytes": path.stat().st_size,
            "outliers_removed": int(len(xyz) - keep.sum())}


def missing_intervals(frames, registered_names, video):
    """Translate missing sample bins to approximate seconds in the original clip."""
    registered = set(registered_names)
    samples = sorted(p.name for p in frames.glob("*.jpg"))
    intervals = []
    for missing, group in groupby(enumerate(samples), key=lambda item: item[1] not in registered):
        if missing:
            indices = [index for index, _ in group]
            end = min((indices[-1] + 1) / video["sample_fps"], video["duration_seconds"])
            intervals.append([round(indices[0] / video["sample_fps"], 2), round(end, 2)])
    return intervals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--output", type=Path, help="new run directory (default: captures-local/runs)")
    parser.add_argument("--fps", type=float, default=3, help="sample rate, capped across the whole clip")
    parser.add_argument("--max-frames", type=int, default=120, help="maximum number of input JPEGs")
    parser.add_argument("--sparse", action="store_true", help="export the triangulated feature tracks only")
    parser.add_argument("--no-preview", action="store_true", help="finish after exporting the PLY and report")
    args = parser.parse_args()
    video = args.video.expanduser().resolve()
    if not video.is_file():
        parser.error(f"Video not found: {video}")
    if not math.isfinite(args.fps) or args.fps <= 0 or args.max_frames < 4:
        parser.error("Use a positive --fps and at least 4 for --max-frames.")
    if args.output:
        run = args.output.expanduser().resolve()
        try:
            run.mkdir(parents=True, exist_ok=False)
        except FileExistsError:
            parser.error(f"Choose a new output directory. {run} already exists.")
    else:
        RUNS.mkdir(parents=True, exist_ok=True)
        prefix = datetime.now().strftime("%Y%m%d-%H%M%S-") + video.stem[:40] + "-"
        run = Path(tempfile.mkdtemp(prefix=prefix, dir=RUNS))
    print(f"Run folder: {run}", flush=True)
    start = time.monotonic()
    report = {"source": video.name, "status": "processing", "units": "arbitrary",
              "axes": "+X image right, +Y image up, -Z forward from first registered camera",
              "warnings": [], "versions": {"pycolmap": pycolmap.__version__,
              "opencv": cv2.__version__, "numpy": np.__version__}}
    report_file = run / "report.json"
    ply = run / "scene.ply"
    try:
        print("1/3  Sampling video frames", flush=True)
        frames = run / "frames"
        report["video"] = extract_frames(video, frames, args.fps, args.max_frames)
        print(f"2/3  Estimating camera poses from {report['video']['sampled_frames']} frames", flush=True)
        pycolmap.logging.minloglevel = pycolmap.logging.WARNING
        model, stats, transform = reconstruct(frames, run / "sfm")
        report["reconstruction"] = stats
        report["world_to_view"] = transform.tolist()
        report["warnings"].extend(stats["warnings"])
        gaps = missing_intervals(frames, stats["registered_frame_names"], report["video"])
        report["unregistered_intervals_seconds"] = gaps
        if gaps:
            times = ", ".join(f"{a:g}–{b:g}s" for a, b in gaps[:6])
            report["warnings"].append(f"Review the source clip around {times}.")
        xyz, rgb = sparse_points(model, transform)
        kind = "sparse"
        if args.sparse:
            print("3/3  Exporting triangulated feature points", flush=True)
        else:
            from stereo import dense_points
            print("3/3  Matching stereo views on the CPU", flush=True)
            dense_xyz, dense_rgb, stereo = dense_points(model, frames, transform)
            report["stereo"] = stereo
            if len(dense_xyz):
                kind = "stereo + sparse"
                xyz, rgb = np.vstack((xyz, dense_xyz)), np.vstack((rgb, dense_rgb))
            else:
                report["warnings"].append("No supported stereo depth. Exported sparse feature points only.")
        report["export"] = {"geometry": kind, **write_cloud(ply, xyz, rgb)}
        report["status"] = "ready"
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError, cv2.error) as error:
        report.update(status="failed", error=str(error))
        print(f"Reconstruction failed: {error}", file=sys.stderr)
    except KeyboardInterrupt:
        report.update(status="interrupted")
    except Exception as error:
        report.update(status="failed", error=str(error))
        raise
    finally:
        report["elapsed_seconds"] = round(time.monotonic() - start, 2)
        report_file.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        print(f"Report: {report_file}", flush=True)
    if report["status"] != "ready":
        return 1
    print(f"{stats['registered_frames']}/{stats['input_frames']} camera poses, "
          f"{report['export']['points']:,} colored points in {report['elapsed_seconds']} s.")
    print(f"3D file: {ply}", flush=True)
    for warning in report["warnings"]:
        print(f"Capture note: {warning}")
    if not args.no_preview:
        return subprocess.call([sys.executable, str(Path(__file__).with_name("preview.py")),
                                str(ply), "--port", "0"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
