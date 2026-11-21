"""Compare two Path viewer exports from the same saved reconstruction and frames."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

import cv2
import numpy as np
import pycolmap


VERTEX = np.dtype([("xyz", "<f4", 3), ("rgb", "u1", 3)])
PROPERTIES = [b"property float " + c for c in (b"x", b"y", b"z")] + [
    b"property uchar " + c for c in (b"red", b"green", b"blue")
]


def read_cloud(path):
    """Read the XYZ/RGB PLY layout produced by the Path viewer exporter."""
    with path.open("rb") as stream:
        header = []
        while len(header) < 30:
            line = stream.readline(512).rstrip()
            if line == b"end_header":
                break
            if not line:
                raise ValueError(f"Incomplete PLY header: {path}")
            header.append(line)
        else:
            raise ValueError(f"Incomplete PLY header: {path}")
        if header[:2] != [b"ply", b"format binary_little_endian 1.0"]:
            raise ValueError(f"Expected a binary little-endian PLY: {path}")
        elements = [line for line in header if line.startswith(b"element ")]
        properties = [line for line in header if line.startswith(b"property ")]
        if len(elements) != 1 or not elements[0].startswith(b"element vertex ") or properties != PROPERTIES:
            raise ValueError(f"Expected the Path viewer's XYZ/RGB vertex layout: {path}")
        count = int(elements[0].split()[-1])
        if count < 1 or path.stat().st_size - stream.tell() != count * VERTEX.itemsize:
            raise ValueError(f"Unexpected PLY payload length: {path}")
        points = np.fromfile(stream, VERTEX, count=count)
    if not np.isfinite(points["xyz"]).all():
        raise ValueError(f"Non-finite point coordinates: {path}")
    return points


def render_cloud(cloud, image, camera, width, height):
    xyz, bgr = cloud
    pose = image.cam_from_world()
    projected = xyz @ pose.rotation.matrix().T + pose.translation
    good = np.flatnonzero(projected[:, 2] > 1e-6)
    uv = camera.img_from_cam(projected[good]) * [width / camera.width, height / camera.height]
    inside = np.isfinite(uv).all(axis=1) & (uv >= 0).all(axis=1) & (uv < [width, height]).all(axis=1)
    u, v = uv[inside].astype(int).T
    ids = good[inside]
    pixels = v * width + u
    depth = np.full(width * height, np.inf, np.float32)
    sample_depth = projected[ids, 2].astype(np.float32)
    np.minimum.at(depth, pixels, sample_depth)
    nearest = sample_depth == depth[pixels]
    center = np.zeros((height * width, 3), np.uint8)
    center[pixels[nearest]] = bgr[ids[nearest]]
    center = center.reshape(height, width, 3)
    # Both clouds use exactly the same five-pixel cross at a given output resolution.
    depth = np.pad(depth.reshape(height, width), 1, constant_values=np.inf)
    center = np.pad(center, ((1, 1), (1, 1), (0, 0)))
    best = np.full((height, width), np.inf, np.float32)
    out = np.empty((height, width, 3), np.uint8)
    out[:] = (25, 29, 24)
    for dy, dx in ((1, 1), (0, 1), (2, 1), (1, 0), (1, 2)):
        z = depth[dy:dy + height, dx:dx + width]
        nearer = z < best
        best[nearer] = z[nearer]
        out[nearer] = center[dy:dy + height, dx:dx + width][nearer]
    return out, np.isfinite(best)


def coverage(mask):
    h, w = mask.shape
    sides = mask[h // 4:3 * h // 4, :]
    side_bands = np.concatenate((sides[:, :w // 4], sides[:, -w // 4:]), axis=1)
    return {"whole": float(mask.mean()), "lower_third": float(mask[2 * h // 3:].mean()),
            "side_bands": float(side_bands.mean())}


def triptych(pictures, seconds, stereo_title="Stereo"):
    height, width = pictures[0].shape[:2]
    panel = np.full((height + 62, 3 * width, 3), 31, np.uint8)
    for index, (picture, title) in enumerate(zip(pictures, ("Phone video", stereo_title, "OpenMVS"))):
        x = index * width
        panel[32:32 + height, x:x + width] = picture
        cv2.putText(panel, title, (x + 9, 23), cv2.FONT_HERSHEY_DUPLEX, .64, (242, 242, 239),
                    1, cv2.LINE_AA)
    cv2.putText(panel, f"{seconds:.2f} s  |  Same camera pose and point budget", (9, height + 53),
                cv2.FONT_HERSHEY_SIMPLEX, .50, (218, 223, 219), 1, cv2.LINE_AA)
    return panel


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="Reconstruction directory holding report.json")
    parser.add_argument("stereo", type=Path, help="Stereo PLY in the shared viewer coordinate frame")
    parser.add_argument("openmvs", type=Path, help="OpenMVS PLY in the same viewer coordinate frame")
    parser.add_argument("output", type=Path, help="New local directory for comparison results")
    parser.add_argument("--model", type=Path, help="Override the saved COLMAP model directory")
    parser.add_argument("--frames", type=Path, help="Override the sampled JPEG directory")
    parser.add_argument("--video", action="store_true", help="Also make an H.264 comparison at the sampled rate")
    args = parser.parse_args()
    report = json.loads((args.run / "report.json").read_text())
    stereo_geometry = report.get("exports", {}).get("stereo", report.get("export", {})).get("geometry")
    stereo_title = "Sparse (stereo fallback)" if stereo_geometry == "sparse" else "Stereo"
    fps = report["video"]["sample_fps"]
    model = args.model or args.run / "sfm/models" / str(report["reconstruction"]["model_id"])
    frames = args.frames or args.run / "frames"
    reconstruction = pycolmap.Reconstruction(model)
    by_name = {im.name: im for im in reconstruction.images.values() if im.has_pose}
    sequence = sorted(frames.glob("*.jpg"))
    if not set(by_name).issubset(p.name for p in sequence) or not by_name:
        raise ValueError("Could not locate the source images for this calibrated model")
    transform = np.asarray(report["world_to_view"])
    paths = [args.stereo, args.openmvs]
    points = [read_cloud(path) for path in paths]
    budget = min(map(len, points))
    clouds = []
    inputs = {}
    for key, path, raw in zip(("stereo", "openmvs"), paths, points):
        inputs[key] = {"name": path.name, "vertices": len(raw),
                       "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        if len(raw) > budget:
            raw = raw[np.random.default_rng(18).choice(len(raw), budget, replace=False)]
        world = (raw["xyz"] - transform[:3, 3]) @ transform[:3, :3]
        clouds.append((world, raw["rgb"][:, ::-1]))
    camera = reconstruction.cameras[next(iter(by_name.values())).camera_id]
    scale = 512 / max(camera.width, camera.height)
    width, height = [max(2, round(n * scale / 2) * 2) for n in (camera.width, camera.height)]
    args.output.mkdir(parents=True, exist_ok=False)
    rows = []
    shared_pixels = 0
    color_error_sum = np.zeros(2, np.float64)
    stills = []
    names = sorted(by_name)
    select = {names[round((len(names) - 1) * t)] for t in (.15, .50, .85)}
    movie = None
    if args.video:
        movie = subprocess.Popen([
            "ffmpeg", "-v", "error", "-nostdin", "-n", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{width * 3}x{height + 62}", "-r", str(fps), "-i", "pipe:0", "-an",
            "-c:v", "libx264", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(args.output / "comparison.mp4")], stdin=subprocess.PIPE)
    try:
        for index, path in enumerate(sequence):
            image = by_name.get(path.name)
            reference = cv2.imread(str(path))
            if reference is None:
                raise ValueError(f"Unreadable camera frame: {path}")
            reference = cv2.resize(reference, (width, height), interpolation=cv2.INTER_AREA)
            if image is None:
                if movie:
                    blank = np.full_like(reference, 31)
                    cv2.putText(blank, "Unregistered frame", (8, height // 2), cv2.FONT_HERSHEY_SIMPLEX,
                                .55, (235, 235, 235), 1, cv2.LINE_AA)
                    movie.stdin.write(triptych([reference, blank, blank], index / fps, stereo_title).tobytes())
                continue
            camera = reconstruction.cameras[image.camera_id]
            pictures = [reference]
            masks = []
            row = {"frame": path.name, "seconds": round(index / fps, 4)}
            for key, cloud in zip(("stereo", "openmvs"), clouds):
                picture, mask = render_cloud(cloud, image, camera, width, height)
                row[key] = coverage(mask)
                pictures.append(picture)
                masks.append(mask)
            shared = masks[0] & masks[1]
            shared_pixels += int(shared.sum())
            for i, picture in enumerate(pictures[1:]):
                color_error_sum[i] += cv2.absdiff(picture, reference)[shared].sum(dtype=np.float64)
            rows.append(row)
            panel = triptych(pictures, index / fps, stereo_title)
            if path.name in select:
                stills.append(panel)
            if movie:
                movie.stdin.write(panel.tobytes())
    finally:
        if movie:
            movie.stdin.close()
            if movie.wait():
                raise RuntimeError("FFmpeg could not encode the comparison")
    if not cv2.imwrite(str(args.output / "comparison.jpg"), np.vstack(stills)):
        raise OSError("Could not write comparison.jpg")
    means = {method: {region: float(np.mean([r[method][region] for r in rows]))
                      for region in rows[0][method]} for method in ("stereo", "openmvs")}
    color_errors = (color_error_sum / (3 * shared_pixels)).tolist() if shared_pixels else [None, None]
    result = {"stereo_label": stereo_title, "mean_absolute_srgb_error_on_shared_pixels": dict(zip(("stereo", "openmvs"), color_errors)),
              "shared_pixels_over_all_frames": shared_pixels,
              "units": "fraction of image pixels covered by at least one projected point",
              "means": means, "points_per_cloud": budget, "inputs": inputs, "width": width,
              "height": height, "splat": "radius 1 pixel, cross, z-buffer", "registered_frames": len(rows),
              "sampled_frames": len(sequence), "frames": rows}
    (args.output / "coverage.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k != "frames"}, indent=2))


if __name__ == "__main__":
    main()
