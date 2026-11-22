"""Compare a default hallway3d demo run with the synthetic camera path and walls."""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import pycolmap

from make_hallway import FPS, SECONDS, HALL_HEIGHT, HALL_LENGTH, HALL_WIDTH, camera_pose


def thumbnail(frame):
    small = cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.int16)


def source_frames(clip, frame_dir, images):
    # The fps filter can select a source frame slightly later than its output timestamp.
    # Match the actual sampled JPEGs to decoded frames, accounting for that offset.
    source = cv2.VideoCapture(str(clip))
    thumbs = []
    while True:
        ok, frame = source.read()
        if not ok:
            break
        thumbs.append(thumbnail(frame))
    source.release()
    if len(thumbs) != FPS * SECONDS:
        raise ValueError('Expected the 216-frame synthetic demo clip')
    thumbs = np.stack(thumbs)
    indices = []
    for image in images:
        frame = cv2.imread(str(frame_dir / image.name))
        if frame is None:
            raise ValueError(f'Missing sampled frame {image.name}')
        diff = np.abs(thumbs - thumbnail(frame)).mean(axis=(1, 2))
        match = int(diff.argmin())
        if diff[match] > 4 or (indices and match <= indices[-1]):
            raise ValueError(f'{image.name} could not be matched to the synthetic demo clip')
        indices.append(match)
    return indices


def similarity(src, dst):
    # Fit just one rotation, translation and positive scale for the entire trajectory.
    x, y = src - src.mean(0), dst - dst.mean(0)
    u, singular_values, vt = np.linalg.svd(x.T @ y)
    signs = np.array([1., 1., np.sign(np.linalg.det(u @ vt))])
    rotation = (u * signs) @ vt
    scale = np.dot(signs, singular_values) / np.sum(x * x)
    return scale * rotation, dst.mean(0) - scale * src.mean(0) @ rotation


def vertices(path, count):
    dtype = np.dtype([('xyz', '<f4', 3), ('rgb', 'u1', 3)])
    with path.open('rb') as stream:
        header = []
        while len(header) < 32:
            line = stream.readline(256)
            header.append(line.rstrip())
            if line == b'end_header\n':
                break
        if (header[-1] != b'end_header' or b'format binary_little_endian 1.0' not in header
                or f'element vertex {count}'.encode() not in header):
            raise ValueError('Expected the video3d binary vertex PLY')
        points = np.fromfile(stream, dtype=dtype)
    if len(points) != count or not count or not np.isfinite(points['xyz']).all():
        raise ValueError('PLY vertex payload differs from the run report or contains nonfinite coordinates')
    return points


def wall_distances(xyz):
    # Closest point on each bounded rectangle. There is no wall behind the camera.
    clamped = np.clip(xyz, 0, [HALL_WIDTH, HALL_HEIGHT, HALL_LENGTH])
    nearest = np.full(len(xyz), np.inf)
    for axis, side in [(0, 0), (0, HALL_WIDTH), (1, 0), (1, HALL_HEIGHT), (2, HALL_LENGTH)]:
        on_wall = clamped.copy()
        on_wall[:, axis] = side
        nearest = np.minimum(nearest, np.linalg.norm(xyz - on_wall, axis=1))
    return nearest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path, help='Output directory from hallway3d demo')
    default_clip = Path(__file__).resolve().parents[4] / 'captures-local/video3d-smoke/hallway.mp4'
    parser.add_argument('--clip', type=Path, default=default_clip, help='Original generated demo video')
    args = parser.parse_args()
    report = json.loads((args.run / 'report.json').read_text())
    if report['status'] != 'ready' or report['export']['geometry'] != 'stereo + sparse':
        raise SystemExit('Expected a completed default demo run with stereo samples')
    model = pycolmap.Reconstruction(args.run / 'sfm/models' / str(report['reconstruction']['model_id']))
    images = sorted((model.image(i) for i in model.reg_image_ids()), key=lambda image: image.name)
    frames = source_frames(args.clip, args.run / 'frames', images)
    expected = np.array([camera_pose(i / (FPS * SECONDS - 1))[0] for i in frames])
    # The fixture has +Y up and +Z forward. Fit in right-handed camera axes.
    expected[:, 1] *= -1
    centers = np.array([image.projection_center() for image in images])
    transform, offset = similarity(centers, expected)
    rms = np.sqrt(np.mean(np.sum((centers @ transform + offset - expected) ** 2, axis=1)))

    points = vertices(args.run / 'scene.ply', report['export']['points'])
    first = images[0]
    camera_xyz = points['xyz'] * [1, -1, -1]  # Viewer right/up/back to COLMAP right/down/forward.
    world = camera_xyz @ first.cam_from_world().rotation.matrix() + first.projection_center()
    fixture = (world @ transform + offset) * [1, -1, 1]
    median, p95 = np.quantile(wall_distances(fixture), [.50, .95])
    # Look inside the lower half of the gold door, clear of its plaque and frame.
    x, y, z = fixture.T
    door = ((x > 1.4) & (x < 2.25) & (y > .25) & (y < 1.25) & (abs(z - HALL_LENGTH) < .10))
    r, g, b = points['rgb'].astype(np.int16).T
    gold = np.count_nonzero(door & (r - g > 35) & (g - b > 60))
    total = report['video']['sampled_frames']
    print(f'Synthetic hallway only, after aligning camera poses to the known scale:\n'
          f'  {len(images)}/{total} camera centers, RMS error {rms:.4f} m\n'
          f'  {len(points):,} PLY points, nearest-surface median {median:.4f} m, P95 {p95:.4f} m\n'
          f'  {gold:,} gold points on the marked door')
    if len(images) < .9 * total or rms > .02 or median > .08 or p95 > .25 or gold < 100:
        raise SystemExit('Synthetic regression: expected ≥90% poses, ≤2 cm pose RMS, '
                         '≤8 cm median and ≤25 cm P95 surface distance, and ≥100 gold points on the door')


if __name__ == '__main__':
    main()
