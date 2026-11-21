"""Recover additional measured surface samples from calibrated native training depth maps."""

import json
import struct
from pathlib import Path

import cv2
import numpy as np
import pycolmap
from scipy.spatial import cKDTree

from mesh_geometry import _read_ply
from plane_native_depth import InsufficientTrainingViews, prepare_native_depth, read_depth_map


def _stable(depth):
    valid = np.where(np.isfinite(depth) & (depth > 0), depth, 0)
    kernel = np.ones((3, 3), np.uint8)
    low = cv2.erode(valid, kernel)
    return low, (low > 0) & (cv2.dilate(valid, kernel) <= 1.06 * low)


def _separated(votes, points, centers, angle):
    """Check all voting camera pairs with a bounded temporary working set."""
    separated = np.zeros(len(points), dtype=bool)
    cos_limit = np.cos(np.deg2rad(angle))
    for j in range(1, len(centers)):
        ids = np.flatnonzero(votes[j] & ~separated)
        for start in range(0, len(ids), 2048):
            selected = ids[start:start + 2048]
            directions = points[selected] - centers[:j + 1, None]
            directions /= np.maximum(np.linalg.norm(directions, axis=2, keepdims=True), 1e-12)
            cosine = np.einsum('ij,kij->ki', directions[-1], directions[:-1])
            separated[selected] |= np.any(votes[:j, selected] & (cosine < cos_limit), axis=0)
    return separated


def _recover(paths, train, in_turn, baseline, transform, voxel):
    # Limit the direct comparisons and stratify larger captures over the saved sequence.
    paths = list(paths)
    sizes, turn_ids, seen = [], [], set()
    for i, path in enumerate(paths):
        # Inspect only size and filename before choosing references and allocating.
        # The full native parser validates calibration, channels and byte length below.
        with path.open('rb') as source:
            header = source.read(30)
            if len(header) != 30 or header[:2] != b'DR':
                raise ValueError(f'Invalid native depth header in {path}')
            w, h = struct.unpack_from('<2I', header, offset=12)
            name_size, = struct.unpack_from('<H', header, offset=28)
            resource = Path(source.read(name_size).decode())
        if (not 0 < w * h <= 4_194_304 or resource.parts[:2] != ('colmap', 'images')
                or len(resource.parts) <= 2):
            raise ValueError(f'Invalid native depth dimensions or source in {path}')
        name = str(Path(*resource.parts[2:]))
        if name not in train or name in seen:
            raise ValueError('Untrained or duplicate native depth reference')
        seen.add(name)
        if name in in_turn:
            turn_ids.append(i)
        sizes.append((w, h))
    if len(paths) > 160:
        # Reserve capacity for a short requested turn embedded in a long recording.
        chosen = np.asarray(turn_ids, dtype=int)
        others = np.setdiff1d(np.arange(len(paths)), chosen)
        turn_count = min(len(chosen), max(80, 160 - len(others)))
        selected_turn = chosen[np.linspace(0, len(chosen) - 1, turn_count, dtype=int)]
        rest = min(160 - turn_count, len(others))
        selected_other = others[np.linspace(0, len(others) - 1, rest, dtype=int)]
        ids = sorted(np.r_[selected_turn, selected_other])
        paths = [paths[i] for i in ids]
        sizes = [sizes[i] for i in ids]
    # Sample at most 1.6M depth pixels across differently sized inputs.
    native_pixels = sum(w * h for w, h in sizes)
    stride = max(4, int(np.ceil(np.sqrt(native_pixels / 1_600_000))))
    while sum(((w + stride - 1) // stride) * ((h + stride - 1) // stride) for w, h in sizes) > 1_600_000:
        stride += 1

    raw, seen = [], set()
    for path in paths:
        name, k, r, c, depth = read_depth_map(path)
        if name not in train or name in seen:
            raise ValueError('Untrained or duplicate depth reference encountered during anchor recovery')
        seen.add(name)
        _, stable = _stable(depth)
        y, x = np.nonzero(stable[::stride, ::stride])
        x *= stride
        y *= stride
        rays = np.column_stack((x, y, np.ones(len(x)))) @ np.linalg.inv(k).T
        raw.append((rays * depth[y, x, None]) @ r + c)
    stats = dict(maps_examined=len(paths), eligible_turn_maps=len(seen & in_turn),
                 pixel_stride=stride, native_voxel_size=voxel, source_samples=sum(map(len, raw)),
                 candidate_voxels=0, tested_novel_voxels=0, accepted_anchors=0)
    if not stats['source_samples'] or not stats['eligible_turn_maps'] or len(paths) < 3:
        return np.empty((0, 3)), stats

    raw = np.concatenate(raw)
    ids = np.unique(np.floor(raw / voxel).astype(np.int64), axis=0, return_index=True)[1]
    points = raw[ids]
    viewer = points @ transform[:3, :3].T + transform[:3, 3]
    novel = np.flatnonzero(cKDTree(baseline).query(viewer, workers=4)[0] > 2 * voxel)
    # Stratified thinning maintains coverage across large rooms while bounding two
    # point-by-camera vote matrices to 80 MB total for 160 maps.
    if len(novel) > 250_000:
        novel = novel[np.linspace(0, len(novel) - 1, 250_000, dtype=int)]
    points, viewer = points[novel], viewer[novel]
    stats.update(candidate_voxels=len(ids), tested_novel_voxels=len(points))
    if not len(points):
        return viewer, stats

    centers, active_turn = [], []
    yes = np.zeros((len(paths), len(points)), dtype=bool)
    free = np.zeros_like(yes)
    for i, path in enumerate(paths):
        name, k, r, center, depth = read_depth_map(path)
        low, stable = _stable(depth)
        cam = (points - center) @ r.T
        z = cam[:, 2]
        uv = np.rint((cam @ k.T)[:, :2] / np.maximum(z[:, None], 1e-6))
        h, w = depth.shape
        x = np.clip(uv[:, 0], 0, w - 1).astype(int)
        y = np.clip(uv[:, 1], 0, h - 1).astype(int)
        inside = ((z > 0) & (uv[:, 0] >= 1) & (uv[:, 1] >= 1)
                  & (uv[:, 0] < w - 1) & (uv[:, 1] < h - 1) & stable[y, x])
        yes[i] = inside & (np.abs(depth[y, x] - z) < .025 * z)
        free[i] = inside & (low[y, x] > 1.12 * z)
        centers.append(center)
        active_turn.append(name in in_turn)

    # A nominated point must agree with a turn view and at least two other
    # estimates. Separated witnesses and competing free-space rays are tested in 3D.
    needed = (yes.sum(axis=0) >= 3) & yes[active_turn].any(axis=0)
    pts = points[needed]
    centers = np.asarray(centers)
    selected = (_separated(yes[:, needed], pts, centers, 5)
                & ~_separated(free[:, needed], pts, centers, 4))
    anchors = viewer[needed][selected]
    stats['accepted_anchors'] = len(anchors)
    return anchors, stats


def get_turn_anchors(run, cache, start, end, *, bin_dir=None):
    """Return only new viewer-space measurements corroborated by training cameras."""
    run = Path(run)
    source = json.loads((run / 'report.json').read_text())
    if not np.isfinite([start, end]).all() or not 0 <= start < end <= source['video']['duration_seconds']:
        raise ValueError('Native anchor interval must lie within the video')
    try:
        directory, train, key = prepare_native_depth(run, cache, bin_dir=bin_dir)
    except InsufficientTrainingViews as exc:
        return np.empty((0, 3)), dict(reason='insufficient_training_cameras', training_cameras=exc.count,
                                      accepted_anchors=0)
    subset = pycolmap.Reconstruction(run / 'openmvs/colmap/sparse')
    centers = np.array([im.projection_center() for im in subset.images.values() if im.name in train])
    extent = float(np.linalg.norm(np.ptp(centers, axis=0)))
    if not np.isfinite(extent) or extent <= 0:
        return np.empty((0, 3)), dict(reason='zero_trajectory_extent', accepted_anchors=0)
    # Quantize the grid to one significant digit to avoid moving voxel boundaries
    # throughout the scene when a single weak end-of-path pose is dropped.
    nominal = .0035 * extent
    voxel = round(nominal, -int(np.floor(np.log10(nominal))))
    fps = source['video']['sample_fps']
    times = {name: (int(Path(name).stem.split('-')[-1]) - 1) / fps for name in train}
    turn = {name for name, time in times.items() if start <= time <= end}
    baseline, _ = _read_ply(run / 'mesh/points.ply')
    transform = np.asarray(source['world_to_view'], dtype=float)
    if (not len(baseline) or not np.isfinite(baseline).all() or transform.shape != (4, 4)
            or not np.isfinite(transform).all()):
        raise ValueError('Native anchor recovery needs finite measured points and a valid viewer frame')
    anchors, stats = _recover(sorted(directory.glob('depth*.dmap')), train, turn, baseline, transform, voxel)
    stats.update(input_sha256=key, training_cameras=len(train), turn_seconds=[start, end],
                 agreement_fraction=.025, minimum_sources=3, minimum_ray_angle_deg=5,
                 separated_conflict_angle_deg=4, free_space_fraction=.12)
    return anchors, stats
