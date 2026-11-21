"""Add geometrically verified full-rate video tracks to a disposable SIFT database."""

from collections import Counter
from pathlib import Path
import subprocess

import cv2
import numpy as np
import pycolmap


TRACK_WIDTH_LIMIT = 800
TRACK_FRAME_BUDGET = 3600
PAIR_OFFSETS = (1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48)


def _source_indices(video, frames, info, work, count):
    """FFmpeg records the source decoder index for each JPEG emitted by its fps filter."""
    path = frames / "source-indices.txt"
    if not path.exists():
        # Runs made by earlier versions contain the JPEGs but lack the timing map.
        path = work / "source-indices.txt"
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(video),
            "-map", f"0:{info['stream']['index']}", "-an", "-sn", "-dn",
            "-vf", f"fps={info['sample_fps']:.10f},scale=2:2", "-frames:v", str(count),
            "-stats_enc_pre", str(path), "-stats_enc_pre_fmt", "{ni}", "-f", "null", "-",
        ], check=True)
    indices = list(map(int, path.read_text().split()))
    if len(indices) != count or not indices or indices[0] < 0 or indices != sorted(indices):
        raise ValueError("The video frame index map does not match the sampled JPEGs.")
    return indices


def _advance(previous, current, points, labels):
    if not len(points):
        return points, labels
    lk = dict(winSize=(25, 25), maxLevel=3, criteria=(3, 25, .02))
    forward, seen, error = cv2.calcOpticalFlowPyrLK(previous, current, points, None, **lk)
    backward, returned, _ = cv2.calcOpticalFlowPyrLK(current, previous, forward, None, **lk)
    h, w = current.shape
    keep = (seen[:, 0].astype(bool) & returned[:, 0].astype(bool)
            & (np.linalg.norm((backward - points)[:, 0], axis=1) < .9)
            & (error[:, 0] < 26) & np.all(forward[:, 0] >= 6, axis=1)
            & np.all(forward[:, 0] < [w - 6, h - 6], axis=1))
    return forward[keep], labels[keep]


def _add_corners(image, points, labels, next_id):
    mask = np.full(image.shape, 255, np.uint8)
    for x, y in np.rint(points[:, 0]).astype(int):
        cv2.circle(mask, (x, y), 5, 0, -1)
    corners = cv2.goodFeaturesToTrack(image, 1600 - len(points), .0035, 5.5, mask=mask, blockSize=5)
    if corners is not None:
        points = np.concatenate((points, corners))
        labels = np.concatenate((labels, np.arange(next_id, next_id + len(corners), dtype=np.int32)))
        next_id += len(corners)
    return points, labels, next_id


def _video_tracks(video, info, indices):
    width, height = info["sample_width"], info["sample_height"]
    ratio = min(1., TRACK_WIDTH_LIMIT / max(width, height))
    w, h = max(2, round(width * ratio)), max(2, round(height * ratio))
    targets = Counter(indices)
    last = indices[-1]
    # For a long clip, bound optical-flow evaluations and retain every requested
    # keyframe even when it falls between stride samples. No full-rate JPEGs on disk.
    stride = max(1, (last + TRACK_FRAME_BUDGET) // TRACK_FRAME_BUDGET)
    visits = sorted(set(range(0, last + 1, stride)).union(targets))
    filters = []
    if stride > 1:
        # Use a balanced expression tree to respect libavutil's parser depth limit.
        selectors = [f"not(mod(n,{stride}))"] + [f"eq(n,{i})" for i in targets if i % stride]
        while len(selectors) > 1:
            selectors = [f"({'+'.join(selectors[j:j+2])})" for j in range(0, len(selectors), 2)]
        filters.append(f"select='{selectors[0]}'")
    scale = f"scale={w}:{h}:flags=area"
    if info["stream"].get("color_transfer") in ("arib-std-b67", "smpte2084"):
        scale += ":out_primaries=bt709:out_transfer=iec61966-2-1:intent=perceptual"
    filters.extend([scale, "format=rgb24", "scale=out_color_matrix=bt601:out_range=full", "format=gray"])
    cmd = [
        "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(video),
        "-map", f"0:{info['stream']['index']}", "-an", "-sn", "-dn", "-vf", ",".join(filters),
        "-fps_mode", "passthrough", "-frames:v", str(len(visits)),
        "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1",
    ]
    points = np.empty((0, 1, 2), np.float32)
    labels = np.empty(0, np.int32)
    next_id = 0
    tracks = []
    previous = None
    with subprocess.Popen(cmd, stdout=subprocess.PIPE) as decoder:
        try:
            for index in visits:
                data = decoder.stdout.read(w * h)
                if len(data) != w * h:
                    raise ValueError(f"Full-rate decode ended before source frame {index}.")
                image = np.frombuffer(data, np.uint8).reshape(h, w)
                if previous is not None:
                    points, labels = _advance(previous, image, points, labels)
                if len(points) < 1300 and (index in targets or len(points) < 450):
                    points, labels, next_id = _add_corners(image, points, labels, next_id)
                if index in targets:
                    # OpenCV pixel-center coordinates to COLMAP corner-origin coordinates.
                    xy = (points[:, 0] + .5) * np.array([width / w, height / h], np.float32)
                    tracks.extend([(labels.copy(), xy)] * targets[index])
                previous = image
            if decoder.wait():
                raise RuntimeError("FFmpeg failed during full-rate video tracking.")
        finally:
            if decoder.poll() is None:
                decoder.kill()
    stats = {"flow_frames": len(visits), "source_frames_through_last_keyframe": last + 1,
             "flow_stride": stride, "flow_tracks": next_id, "tracking_size": [w, h],
             "keyframes": len(indices), "unique_keyframe_sources": len(targets)}
    return tracks, stats


def augment_tracks(video: Path, frames: Path, video_info: dict, database: Path, work: Path):
    """Enrich and verify a dedicated mapping-only copy; retain the original SIFT DB."""
    work.mkdir(parents=True, exist_ok=True)
    with pycolmap.Database.open(database) as db:
        images = sorted(db.read_all_images(), key=lambda image: image.name)
    names = [image.name for image in images]
    if names != sorted(p.name for p in frames.iterdir() if p.suffix.lower() in {".jpg", ".jpeg"}):
        raise ValueError("Sampled JPEG names differ from the feature database.")
    indices = _source_indices(video, frames, video_info, work, len(names))
    tracks, stats = _video_tracks(video, video_info, indices)
    pairs = []
    added = 0
    offsets = []
    with pycolmap.Database.open(database) as db:
        for image, (_, xy) in zip(images, tracks):
            features = db.read_keypoints(image.image_id)
            offsets.append(len(features))
            extra = np.zeros((len(xy), features.shape[1]), np.float32)
            extra[:, :2] = xy
            if extra.shape[1] == 4:
                extra[:, 2] = 1
            if extra.shape[1] == 6:
                extra[:, 2] = extra[:, 5] = 1
            db.update_keypoints(image.image_id, np.concatenate((features, extra)))

        for i, (labels, _) in enumerate(tracks):
            for step in PAIR_OFFSETS:
                j = i + step
                if j >= len(images):
                    break
                if indices[i] == indices[j]:
                    continue
                _, left, right = np.intersect1d(labels, tracks[j][0], assume_unique=True, return_indices=True)
                if len(left) < 20:
                    continue
                matches = np.column_stack((left + offsets[i], right + offsets[j])).astype(np.uint32)
                added += len(matches)
                pair = images[i].image_id, images[j].image_id
                if db.exists_matches(*pair):
                    matches = np.concatenate((db.read_matches(*pair), matches))
                    db.delete_matches(*pair)
                db.write_matches(*pair, matches)
                if db.exists_two_view_geometry(*pair):
                    db.delete_two_view_geometry(*pair)
                pairs.append((i, j))
        # Optical-flow corners have no SIFT descriptors. The copy is for mapping
        # geometrically verified matches; new descriptor matching uses the original.
        db.clear_descriptors()

    if pairs:
        path = work / "tracking-pairs.txt"
        path.write_text("".join(f"{names[i]} {names[j]}\n" for i, j in pairs))
        verification = pycolmap.TwoViewGeometryOptions(ransac={"max_error": 2.5, "max_num_trials": 2000})
        pycolmap.verify_matches(database, path, verification)
    return dict(stats, augmented_pairs=len(pairs), added_correspondences=added)
