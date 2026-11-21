"""Estimate colored surface samples from overlapping registered video frames on CPU."""

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


MAX_PAIRS = 100
MAX_SIDE = 800
POINTS_PER_PAIR = 9_500
MIN_SHARED_TRACKS = 24


@dataclass
class View:
    name: str
    rotation: np.ndarray
    translation: np.ndarray
    center: np.ndarray
    tracks: set


def _registered_views(model):
    views = []
    for image_id in model.reg_image_ids():
        image = model.image(image_id)
        pose = image.cam_from_world()
        tracks = {p.point3D_id for p in image.get_observation_points2D()}
        views.append(View(image.name, pose.rotation.matrix(), pose.translation.copy(),
                          image.projection_center(), tracks))
    return sorted(views, key=lambda view: view.name)


def _select_pairs(views, landmarks):
    # Sample references throughout the clip; use a second camera with enough
    # motion to triangulate, while retaining feature tracks seen by both.
    pairs = []
    anchors = np.linspace(0, len(views) - 2, min(MAX_PAIRS, len(views) - 1), dtype=int)
    for index in anchors:
        left = views[index]
        best_score = 0
        best_pair = None
        for right in views[index + 1:index + 13]:
            shared = sorted(left.tracks & right.tracks)
            if len(shared) < MIN_SHARED_TRACKS:
                continue
            sample = shared[::max(1, len(shared) // 256)]
            points = np.array([landmarks[key] for key in sample])
            left_rays = points - left.center
            right_rays = points - right.center
            cross = np.linalg.norm(np.cross(left_rays, right_rays), axis=1)
            dot = np.sum(left_rays * right_rays, axis=1)
            angle = np.degrees(np.median(np.arctan2(cross, dot)))
            if not 1.25 <= angle <= 25:
                continue
            score = np.sqrt(len(shared)) * min(angle / 6, 6 / angle)
            if score > best_score:
                best_score, best_pair = score, (left, right, points)
        if best_pair is not None:
            pairs.append(best_pair)
    return pairs


def _texture(gray):
    gray = gray.astype(np.float32)
    mean = cv2.blur(gray, (7, 7))
    return cv2.blur(gray * gray, (7, 7)) - mean * mean > 5 ** 2


def _match(left, right, first, count):
    matcher = cv2.StereoSGBM_create(
        minDisparity=first, numDisparities=count, blockSize=5, P1=200, P2=800,
        disp12MaxDiff=1, uniquenessRatio=12, speckleWindowSize=60,
        speckleRange=2, mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY,
    )
    return matcher.compute(left, right).astype(np.float32) / 16


def _rectified_pair(images, intrinsics, distortion, rotation, translation, landmarks):
    h, w = images[0].shape[:2]
    size = w, h
    rotations = cv2.stereoRectify(intrinsics, distortion, intrinsics, distortion,
                                  size, rotation, translation.reshape(3, 1), flags=cv2.CALIB_ZERO_DISPARITY)
    r1, r2, p1, p2 = rotations[:4]
    axis = int(abs(p2[1, 3]) > abs(p2[0, 3]))
    # Near/far bounds come from shared tracked geometry in rectified-camera Z.
    depths = landmarks @ r1[2]
    depths = depths[depths > 0]
    if len(depths) < MIN_SHARED_TRACKS:
        return None
    near, far = np.quantile(depths, [0.02, 0.98]) * [0.72, 1.45]
    baseline_f = -p2[axis, 3]
    disparity_range = min(192, (size[axis] // 3) // 16 * 16,
                          int(np.ceil(abs(baseline_f) / near / 16)) * 16 + 16)
    if disparity_range < 16 or abs(baseline_f) / near < 1:
        return None

    # Rectifying a partly forward walk can move the principal point thousands
    # of pixels off screen. Black-border mask agreement alone can still leave
    # a sliver of repeated texture with misleading disparities. Require the
    # measured tracks to survive both warps and the actual disparity search.
    rect_xyz = landmarks @ r1.T
    left_uvz = rect_xyz @ p1[:, :3].T
    right_uvz = rect_xyz @ p2[:, :3].T + p2[:, 3]
    def visible(uvz):
        u, v, z = uvz.T
        return (z > 0) & (u >= 0) & (u < w * z) & (v >= 0) & (v < h * z)
    searchable = (visible(left_uvz) & visible(right_uvz)
                  & (rect_xyz[:, 2] * disparity_range > abs(baseline_f)))
    if np.mean(searchable) < 0.45:
        return None

    grays, masks = [], []
    for image, rect, projection in zip(images, (r1, r2), (p1, p2)):
        mx, my = cv2.initUndistortRectifyMap(intrinsics, distortion, rect, projection[:, :3],
                                              size, cv2.CV_32FC1)
        rectified = cv2.remap(image, mx, my, cv2.INTER_LINEAR)
        valid = (mx >= 3) & (mx <= w - 4) & (my >= 3) & (my <= h - 4)
        if not grays:
            colors = rectified
        gray = cv2.cvtColor(rectified, cv2.COLOR_BGR2GRAY)
        grays.append(np.ascontiguousarray(gray.T if axis else gray))
        masks.append(valid.T if axis else valid)

    first = 0 if baseline_f > 0 else 1 - disparity_range
    reverse_first = 1 - disparity_range - first
    forward = _match(*grays, first, disparity_range)
    reverse = _match(grays[1], grays[0], reverse_first, disparity_range)
    rows, cols = np.indices(forward.shape)
    other_x = np.rint(cols - forward).astype(np.int32)
    inside = (other_x >= 0) & (other_x < forward.shape[1])
    other_x = other_x.clip(0, forward.shape[1] - 1)
    reverse_at_match = reverse[rows, other_x]
    valid = (masks[0] & masks[1][rows, other_x] & inside & _texture(grays[0])
             & (forward >= first) & (reverse_at_match >= reverse_first)
             & (np.abs(forward + reverse_at_match) <= 1.0) & (abs(forward) > 1))
    # Both directions must match appearance, even on smooth or repetitive walls.
    valid &= abs(grays[0].astype(np.int16) - grays[1][rows, other_x]) <= 30
    depth = np.divide(baseline_f, forward, out=np.zeros_like(forward), where=abs(forward) > 1)
    valid &= (depth >= near) & (depth <= far)
    rows, cols = np.where(valid)
    z = depth[rows, cols]
    y, x = (cols, rows) if axis else (rows, cols)
    rect_xyz = np.column_stack(((x - p1[0, 2]) * z / p1[0, 0],
                                (y - p1[1, 2]) * z / p1[1, 1], z))
    return rect_xyz @ r1, colors[y, x, ::-1]


def _sweep(reference, other, k, rotation, translation, landmarks):
    # An axial walk puts the epipole inside the frame. Sweeping calibrated
    # fronto-parallel planes avoids warping away the center of the hallway.
    size = reference.shape[1], reference.shape[0]
    z = landmarks[:, 2]
    if np.count_nonzero(z > 0) < MIN_SHARED_TRACKS:
        return None
    near, far = np.quantile(z[z > 0], [0.02, 0.98]) * [0.72, 1.45]
    inv_depths = np.linspace(1 / far, 1 / near, 48)
    inv_k = np.linalg.inv(k)
    costs = np.empty((len(inv_depths), *reference.shape), dtype=np.float32)
    for i, inv_depth in enumerate(inv_depths):
        plane = rotation.copy()
        plane[:, 2] += translation * inv_depth
        homography = k @ plane @ inv_k
        warped = cv2.warpPerspective(other, homography, size,
                                     flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                                     borderMode=cv2.BORDER_CONSTANT, borderValue=-255)
        difference = np.minimum(np.abs(reference - warped), 40)
        difference[warped < 0] = 100
        costs[i] = cv2.blur(difference, (5, 5))
    winner = costs.argmin(axis=0)
    rows, cols = np.indices(winner.shape)
    best = costs[winner, rows, cols]
    lower = costs[(winner - 1).clip(0), rows, cols]
    upper = costs[(winner + 1).clip(max=len(costs) - 1), rows, cols]
    curvature = lower + upper - 2 * best
    fraction = np.divide(0.5 * (lower - upper), curvature, out=np.zeros_like(best),
                         where=curvature > 1e-5).clip(-0.5, 0.5)
    # Competing minima beside the winning depth plane represent the same
    # surface. A distinct hypothesis with similar cost indicates ambiguity.
    for offset in range(-2, 3):
        costs[(winner + offset).clip(0, len(costs) - 1), rows, cols] = np.inf
    other_cost = costs.min(axis=0)
    valid = (_texture(reference) & (best < 17) & (other_cost - best > 1.6)
             & (other_cost > 1.18 * best) & (winner > 0) & (winner < len(costs) - 1))
    depth = 1 / (inv_depths[winner] + fraction * (inv_depths[1] - inv_depths[0]))
    return depth, valid, inv_depths[1] - inv_depths[0]


def _axial_pair(images, k, distortion, rotation, translation, landmarks):
    # Sweep at half resolution to cap the cost of checking both directions.
    h, w = images[0].shape[:2]
    size = (max(1, w // 2), max(1, h // 2))
    sweep_k = k.copy()
    sweep_k[0] *= size[0] / w
    sweep_k[1] *= size[1] / h
    mx, my = cv2.initUndistortRectifyMap(k, distortion, np.eye(3), sweep_k,
                                         size, cv2.CV_32FC1)
    rect = [cv2.remap(image, mx, my, cv2.INTER_LINEAR) for image in images]
    grays = [cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32) for im in rect]
    inside = (mx >= 3) & (my >= 3) & (mx < w - 3) & (my < h - 3)
    for gray in grays:
        gray[~inside] = -255
    first = _sweep(*grays, sweep_k, rotation, translation, landmarks)
    second = _sweep(grays[1], grays[0], sweep_k, rotation.T, -rotation.T @ translation,
                    landmarks @ rotation.T + translation)
    if first is None or second is None:
        return None

    depth, valid, _ = first
    other_depth, other_valid, step = second
    y, x = np.where(valid & inside)
    z = depth[y, x]
    xyz = np.column_stack(((x - sweep_k[0, 2]) * z / sweep_k[0, 0],
                           (y - sweep_k[1, 2]) * z / sweep_k[1, 1], z))
    projected = (xyz @ rotation.T + translation) @ sweep_k.T
    front = projected[:, 2] > 0
    xyz, y, x, projected = xyz[front], y[front], x[front], projected[front]
    xy = np.rint(projected[:, :2] / projected[:, 2:]).astype(int)
    u, v = xy.T
    good = (u >= 0) & (v >= 0) & (u < size[0]) & (v < size[1])
    xyz, y, x = xyz[good], y[good], x[good]
    u, v, other_z = u[good], v[good], projected[good, 2]
    consistent = (inside[v, u] & other_valid[v, u]
                  & (abs(1 / other_depth[v, u] - 1 / other_z) < 1.7 * step))
    return xyz[consistent], rect[0][y[consistent], x[consistent], ::-1]


def _track_support(xyz, tracked):
    # Compare in normalized camera coordinates, where radial distortion is
    # already removed. Nearby reconstructed tracks constrain depth even when
    # a repeated texture produces an apparently consistent stereo match.
    tracked = tracked[tracked[:, 2] > 0]
    good = np.flatnonzero(xyz[:, 2] > 0)
    if len(tracked) < 8 or not len(good):
        return good[:0]
    features = np.ascontiguousarray(tracked[:, :2] / tracked[:, 2:], np.float32)
    pixels = np.ascontiguousarray(xyz[good, :2] / xyz[good, 2:], np.float32)
    tree = cv2.flann_Index(features, dict(algorithm=1, trees=2))
    neighbors, distances = tree.knnSearch(pixels, 8, params={'checks': 32})
    # Permit sloping surfaces to vary in depth across the angular search
    # radius. Two distinct nearby feature tracks must agree with the sample.
    radius = np.sqrt(distances)
    depth_error = np.abs(tracked[neighbors, 2] / xyz[good, 2:3] - 1)
    supports = (radius < 0.09) & (depth_error < 0.045 + radius * 0.9)
    return good[np.count_nonzero(supports, axis=1) >= 2]


def dense_points(model, frames: Path, world_to_view: np.ndarray):
    """Return viewer-space XYZ, byte RGB and JSON-serializable pair diagnostics."""
    frames = Path(frames)
    views = _registered_views(model)
    stats = dict(pairs_considered=0, pairs_used=0, rectified_pairs=0,
                 axial_pairs=0, dense_points=0, rejected_by_track_depth=0)
    positions, colors = [], []

    # The sparse stage ties all frames to one SIMPLE_RADIAL camera.
    if len(views) >= 2 and len(model.cameras) == 1:
        camera = next(iter(model.cameras.values()))
        if camera.model_name == 'SIMPLE_RADIAL':
            landmarks = {key: np.array(point.xyz) for key, point in model.points3D.items()}
            verified = {key for key, point in model.points3D.items()
                        if point.track.length() >= 3 and point.error <= 2.5}
            scale = min(1.0, MAX_SIDE / max(camera.width, camera.height))
            size = round(camera.width * scale), round(camera.height * scale)
            k = camera.calibration_matrix().copy()
            # COLMAP measures pixels from the top left corner, OpenCV from
            # pixel centers. Apply this offset after scaling the intrinsics.
            k[0] *= size[0] / camera.width
            k[1] *= size[1] / camera.height
            k[:2, 2] -= 0.5
            distortion = np.array([camera.params[3], 0, 0, 0], dtype=np.float64)
            for left, right, points in _select_pairs(views, landmarks):
                stats['pairs_considered'] += 1
                images = [cv2.imread(str(frames / v.name), cv2.IMREAD_COLOR)
                          for v in (left, right)]
                if any(im is None or im.shape[:2] != (camera.height, camera.width) for im in images):
                    continue
                images = [cv2.resize(im, size, interpolation=cv2.INTER_AREA) for im in images]
                rotation = right.rotation @ left.rotation.T
                translation = right.translation - rotation @ left.translation
                left_points = points @ left.rotation.T + left.translation
                # Approximate epipole position in the second camera.
                axial = np.linalg.norm(translation[:2]) < 0.75 * abs(translation[2])
                method = _axial_pair if axial else _rectified_pair
                samples = method(images, k, distortion, rotation, translation, left_points)
                if samples is None and not axial:
                    axial = True
                    samples = _axial_pair(images, k, distortion, rotation, translation, left_points)
                if samples is None or len(samples[0]) < 64:
                    continue
                xyz, rgb = samples
                tracks = [landmarks[key] for key in sorted(left.tracks & verified)]
                if len(tracks) < 8:
                    continue
                tracked_xyz = np.asarray(tracks) @ left.rotation.T + left.translation
                valid = _track_support(xyz, tracked_xyz)
                stats['rejected_by_track_depth'] += len(xyz) - len(valid)
                if len(valid) < 64:
                    continue
                pick = valid[np.linspace(0, len(valid) - 1,
                                         min(len(valid), POINTS_PER_PAIR), dtype=int)]
                world = (xyz[pick] - left.translation) @ left.rotation
                positions.append(world @ world_to_view[:3, :3].T + world_to_view[:3, 3])
                colors.append(rgb[pick])
                stats['pairs_used'] += 1
                stats['axial_pairs' if axial else 'rectified_pairs'] += 1
    if not positions:
        stats['reason'] = 'No stereo pair passed overlap, parallax and pixel consistency checks.'
        return np.empty((0, 3), np.float32), np.empty((0, 3), np.uint8), stats
    stats['dense_points'] = sum(map(len, positions))
    return np.concatenate(positions).astype(np.float32), np.concatenate(colors), stats
