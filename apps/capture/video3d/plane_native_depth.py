"""Veto a proposed triangle when separated training cameras see through its interior."""

import hashlib
import json
import struct
import tempfile
from pathlib import Path

import cv2
import numpy as np
import pycolmap

from openmvs import _run, resolve_tools
from plane_views import ordered_poses, training_photo


def read_depth_map(path):
    """Read the v2.4 OpenMVS raw DMap header, calibrated projection and z-depth."""
    header = struct.Struct('<2sBB4I2f')
    def read_exact(source, size):
        data = source.read(size)
        if len(data) != size:
            raise ValueError(f'Truncated OpenMVS depth map {path}')
        return data

    with Path(path).open('rb') as source:
        magic, flags, _, iw, ih, w, h, near, far = header.unpack(read_exact(source, header.size))
        if (magic != b'DR' or not flags & 1 or flags & ~15 or (iw, ih) != (w, h)
                or min(w, h) < 3 or w * h > 4_194_304 or not np.isfinite([near, far]).all() or not 0 < near < far):
            raise ValueError(f'Unsupported OpenMVS depth format or resolution in {path}')
        name_size, = struct.unpack('<H', read_exact(source, 2))
        resource = Path(read_exact(source, name_size).decode())
        if len(resource.parts) < 3 or resource.parts[:2] != ('colmap', 'images') or '..' in resource.parts:
            raise ValueError(f'Unexpected depth source path in {path}')
        name = str(Path(*resource.parts[2:]))
        views, = struct.unpack('<I', read_exact(source, 4))
        if not 1 <= views <= 10000:
            raise ValueError(f'Invalid view count in {path}')
        source.seek(4 * views, 1)
        calibration = np.frombuffer(read_exact(source, 21 * 8), dtype='<f8')
        k, r, c = calibration[:9].reshape(3, 3), calibration[9:18].reshape(3, 3), calibration[18:]
        if (not np.isfinite(calibration).all() or not np.allclose(r.T @ r, np.eye(3), atol=1e-6)
                or not np.allclose(k[2], [0, 0, 1]) or np.linalg.det(r) < 0
                or min(k[0, 0], k[1, 1]) <= 0):
            raise ValueError(f'Invalid calibration in {path}')
        channels = 1 + 3 * bool(flags & 2) + bool(flags & 4) + bool(flags & 8)
        if Path(path).stat().st_size - source.tell() != channels * w * h * 4:
            raise ValueError(f'Incorrect depth payload length in {path}')
        z = np.frombuffer(read_exact(source, w * h * 4), dtype='<f4').reshape(h, w)
    return name, k, r, c, z


def depth_veto(directory, triangles, world_to_view, allowed_names):
    """Return mask and counts in input order. Only allowed reference camera maps are read.

    Use a directory from a depth run that used allowed_names as *both* references and
    sources. Copied maps estimated using held-out source images are unsuitable.
    """
    triangles = np.asarray(triangles, np.float64)
    transform = np.asarray(world_to_view, np.float64)
    world = (triangles - transform[:3, 3]) @ transform[:3, :3]
    weights = np.asarray([[1/3, 1/3, 1/3], [.7, .15, .15], [.15, .7, .15],
                          [.15, .15, .7], [.45, .45, .1], [.45, .1, .45], [.1, .45, .45]])
    samples = weights @ world
    n = len(world)
    ctr = world.mean(axis=1)
    kernel = np.ones((3, 3), np.uint8)
    names, centers, conflicts, agreements = [], [], [], []
    for path in sorted(Path(directory).glob('depth*.dmap')):
        name, k, r, center, depth = read_depth_map(path)
        if name not in allowed_names or name in names:
            raise ValueError(f'Unexpected or duplicate depth reference {name}')
        valid = np.isfinite(depth) & (depth > 0)
        clean = np.where(valid, depth, 0)
        lo = cv2.erode(clean, kernel)
        hi = cv2.dilate(clean, kernel)
        stable = (lo > 0) & (hi <= 1.06 * lo)
        cam = (samples - center) @ r.T
        z = cam[:, :, 2]
        pixel = cam @ k.T
        uv = np.rint(pixel[:, :, :2] / np.maximum(z[:, :, None], 1e-6))
        h, w = depth.shape
        x = np.clip(uv[:, :, 0], 0, w - 1).astype(np.intp)
        y = np.clip(uv[:, :, 1], 0, h - 1).astype(np.intp)
        on = ((z > 0) & (uv[:, :, 0] >= 1) & (uv[:, :, 1] >= 1)
              & (uv[:, :, 0] < w - 1) & (uv[:, :, 1] < h - 1) & stable[y, x])
        # A farther measured surface means the proposed face occupies observed free space.
        conflicts.append(np.count_nonzero(on & (lo[y, x] > 1.12 * z), axis=1) >= 5)
        agreements.append(np.count_nonzero(on & (np.abs(depth[y, x] - z) < .045 * z), axis=1) >= 5)
        centers.append(center)
        names.append(name)
    if not names:
        raise ValueError('No native OpenMVS depth maps found')
    conflicts = np.array(conflicts)
    agreements = np.array(agreements)
    separated = np.zeros(n, dtype=bool)
    for j, votes in enumerate(conflicts):
        idx = np.flatnonzero(votes & ~separated)
        if j == 0 or not len(idx):
            continue
        prior = conflicts[:j, idx]
        dirs = ctr[idx] - np.array(centers[:j + 1])[:, None]
        dirs /= np.maximum(np.linalg.norm(dirs, axis=2, keepdims=True), 1e-12)
        cos = np.einsum('ij,kij->ki', dirs[-1], dirs[:-1])
        separated[idx] |= np.any(prior & (cos < np.cos(np.deg2rad(4.0))), axis=0)
    return separated, {'names': names, 'conflicts': conflicts, 'agreements': agreements}


DENSE_ARGS = ['-i', 'train.mvs', '-o', 'train-dense.mvs', '--archive-type', '1',
              '--resolution-level', '0', '--max-resolution', '640', '--min-resolution', '320',
              '--number-views', '4', '--number-views-fuse', '3', '--estimate-colors', '0',
              '--tower-mode', '0', '--crop-to-roi', '0', '--estimate-roi', '0',
              '--remove-dmaps', '0', '--max-threads', '6']


def _hash(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _map_hashes(directory):
    paths = sorted(directory.glob('depth*.dmap'))
    if not paths:
        raise ValueError('OpenMVS returned no native depth maps for the training views')
    return {path.name: _hash(path) for path in paths}


class InsufficientTrainingViews(ValueError):
    def __init__(self, count):
        super().__init__('At least three supported training cameras are needed for native depth')
        self.count = count


def prepare_native_depth(run, work, *, bin_dir=None):
    """Create or reuse a verified cache for the exact training model, images and native tools."""
    run, work = Path(run).resolve(), Path(work).resolve()
    source_dir = run / 'openmvs/colmap'
    photo_root = (source_dir / 'images').resolve()
    report = json.loads((run / 'report.json').read_text())
    weak = set(report['reconstruction'].get('weak_frame_names', []))
    model = pycolmap.Reconstruction(source_dir / 'sparse')
    sequence = ordered_poses(model)
    train = {im.name for index, im in enumerate(sequence)
             if training_photo(index, im.num_points3D, im.name in weak)}
    if len(train) < 3:
        raise InsufficientTrainingViews(len(train))
    excluded_frames = {im.frame_id for im in sequence if im.name not in train}
    if any(im.name in train and im.frame_id in excluded_frames for im in sequence):
        raise ValueError('A rig frame spans training and held-out images')
    input_images = {}
    for name in sorted(train):
        path = (photo_root / name).resolve()
        if Path(name).is_absolute() or '..' in Path(name).parts or not path.is_relative_to(photo_root):
            raise ValueError('Calibrated photo path escapes the saved image directory')
        input_images[name] = _hash(path)
    interface, densify = resolve_tools(bin_dir)
    provenance = dict(format_version=1, args=DENSE_ARGS, train_images=input_images,
                      native_tools=[_hash(interface), _hash(densify)],
                      model={p.name: _hash(p) for p in sorted((source_dir / 'sparse').glob('*.bin'))})
    key = hashlib.sha256(json.dumps(provenance, sort_keys=True).encode()).hexdigest()
    work.mkdir(parents=True, exist_ok=True)
    directory = work / ('native-depth-' + key)
    manifest = directory / 'manifest.json'
    if directory.exists():
        cached = json.loads(manifest.read_text())
        if cached.get('inputs') != provenance or _map_hashes(directory) != cached.get('maps'):
            raise ValueError(f'Native depth cache failed checksum validation at {directory}')
    else:
        with tempfile.TemporaryDirectory(prefix='.native-depth-', dir=work) as tmp:
            stage = Path(tmp) / 'data'
            photos = stage / 'colmap/images'
            sparse = stage / 'colmap/sparse'
            photos.mkdir(parents=True)
            sparse.mkdir()
            for frame_id in sorted(excluded_frames):
                model.deregister_frame(frame_id)
            for name in sorted(train):
                dest = photos / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.symlink_to(photo_root / name)
            model.write(sparse)
            subset = pycolmap.Reconstruction(sparse)
            if {im.name for im in subset.images.values()} != train:
                raise ValueError('Exported OpenMVS subset differs from the requested training split')
            for tool, options in ((interface, ['-i', 'colmap', '-o', 'train.mvs']), (densify, DENSE_ARGS)):
                try:
                    _run(tool, options, stage)
                except RuntimeError as exc:
                    # The temporary build goes away on failure. Keep its diagnostic with the run report.
                    log = stage / (Path(tool).name + '.log')
                    with log.open('rb') as stream:
                        stream.seek(max(0, log.stat().st_size - 1500))
                        tail = stream.read().decode(errors='replace').strip()
                    raise RuntimeError(f'{Path(tool).name} could not build training depth maps. {tail}') from exc
            maps = _map_hashes(stage)
            (stage / 'manifest.json').write_text(json.dumps(dict(inputs=provenance, maps=maps), sort_keys=True))
            try:
                stage.rename(directory)
            except OSError:
                # Another invocation may have published the same complete cache first.
                if not manifest.is_file():
                    raise
                cached = json.loads(manifest.read_text())
                if cached.get('inputs') != provenance or _map_hashes(directory) != cached.get('maps'):
                    raise ValueError(f'Conflicting native depth cache at {directory}')
    return directory, train, key


def prepare_and_veto(run, work, vertices, faces, *, bin_dir=None):
    """Return a keep mask aligned with proposal faces and JSON-compatible audit counts."""
    vertices, faces = np.asarray(vertices), np.asarray(faces)
    if (vertices.ndim != 2 or vertices.shape[1:] != (3,) or not np.isfinite(vertices).all()
            or faces.ndim != 2 or faces.shape[1:] != (3,) or faces.dtype.kind not in 'iu'
            or np.any(faces < 0) or np.any(faces >= len(vertices))):
        raise ValueError('Expected finite viewer-space vertices and valid triangle indices')
    try:
        directory, train, key = prepare_native_depth(run, work, bin_dir=bin_dir)
    except InsufficientTrainingViews as exc:
        return np.zeros(len(faces), dtype=bool), dict(
            reason='insufficient_training_cameras', training_cameras=exc.count,
            tested_faces=0, native_depth_maps=0, rejected_no_agreement=0,
            skipped_faces=len(faces))
    transform = np.asarray(json.loads((Path(run) / 'mesh/report.json').read_text())['world_to_view'])
    if (transform.shape != (4, 4) or not np.isfinite(transform).all()
            or not np.allclose(transform[:3, :3].T @ transform[:3, :3], np.eye(3), atol=1e-6)
            or not np.allclose(transform[3], [0, 0, 0, 1])):
        raise ValueError('Invalid viewer frame for native depth audit')
    keep = np.ones(len(faces), dtype=bool)
    observed, mixed, map_count = 0, 0, len(list(directory.glob('depth*.dmap')))
    for start in range(0, len(faces), 8192):
        tri = vertices[faces[start:start + 8192]]
        separated, details = depth_veto(directory, tri, transform, train)
        agreement = details['agreements'].any(axis=0)
        keep[start:start + len(tri)] = ~separated
        observed += int(agreement.sum())
        mixed += int((separated & agreement).sum())
    return keep, dict(training_cameras=len(train), native_depth_maps=map_count,
                      input_sha256=key, tested_faces=len(faces), any_agreeing_view=observed,
                      rejected_faces=int((~keep).sum()), rejected_with_mixed_depth=mixed,
                      depth_threshold_fraction=.12, agreement_fraction=.045,
                      minimum_ray_angle_deg=4, minimum_interior_votes=5, probes_per_face=7)
