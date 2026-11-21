"""Recover camera poses and colored feature tracks from sequential video frames."""

import os
from pathlib import Path

import numpy as np
import pycolmap


MIN_DEPTH_PAIRS = 2
CAPTURE_HINT = (
    "Walk slowly past textured features and keep them in view from several "
    "positions. Include sideways movement, especially when filming a turn."
)


def _depth_pairs(database):
    """Find pairs where matched image features support geometry beyond a homography."""
    config = pycolmap.TwoViewGeometryConfiguration
    with pycolmap.Database.open(database) as db:
        ids, geometries = db.read_two_view_geometries()
    # A single plane or stationary pan can fit a homography and yield spurious
    # camera centers after bundle adjustment. Check independent two-view fits
    # on image measurements, before relying on the estimated 3D points.
    return [
        pycolmap.pair_id_to_image_pair(pair_id)
        for pair_id, geometry in zip(ids, geometries)
        if geometry.config in (config.CALIBRATED, config.UNCALIBRATED)
        and len(geometry.inlier_matches) >= 30
    ]


def _check_depth(pair_count):
    if pair_count < MIN_DEPTH_PAIRS:
        raise RuntimeError(
            f"Insufficient parallax: {pair_count} frame pairs show reliable depth "
            f"beyond a single plane (need {MIN_DEPTH_PAIRS}). A stationary pan cannot "
            f"recover hallway depth. {CAPTURE_HINT}"
        )


def reconstruct(frames: Path, work: Path):
    """Map a single-camera sequence of zero-padded JPEGs in a fresh workspace."""
    names = sorted(p.name for p in frames.iterdir() if p.suffix.lower() in {".jpg", ".jpeg"})
    if len(names) < 4:
        raise ValueError(f"Need at least 4 sampled frames, found {len(names)}. {CAPTURE_HINT}")

    database = work / "features.db"
    models_dir = work / "models"
    if database.exists() or models_dir.exists():
        raise ValueError("Reconstruction work files already exist. Choose a fresh output directory.")
    models_dir.mkdir(parents=True)
    # Each CPU SIFT worker owns image pyramids, which are large on a phone clip.
    threads = min(4, os.cpu_count() or 1)
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.num_threads = threads
    extraction.sift.max_num_features = 4096
    pycolmap.extract_features(
        database, frames, image_names=names, camera_mode=pycolmap.CameraMode.SINGLE,
        reader_options=pycolmap.ImageReaderOptions(camera_model="SIMPLE_RADIAL"),
        extraction_options=extraction, device=pycolmap.Device.cpu,
    )
    matching = pycolmap.FeatureMatchingOptions(num_threads=threads)
    pycolmap.match_sequential(
        database, matching_options=matching,
        pairing_options=pycolmap.SequentialPairingOptions(overlap=8),
        device=pycolmap.Device.cpu,
    )
    depth_pairs = _depth_pairs(database)
    _check_depth(len(depth_pairs))
    mapping = pycolmap.IncrementalPipelineOptions()
    mapping.num_threads = threads
    mapping.min_model_size = 4
    # Adjacent video frames have smaller baselines than typical photo collections.
    mapping.mapper.init_min_tri_angle = 5.0
    models = pycolmap.incremental_mapping(database, frames, models_dir, options=mapping)
    if not models:
        raise RuntimeError(f"No camera trajectory could be triangulated from {len(names)} frames. {CAPTURE_HINT}")

    # Disconnected components have unrelated coordinate systems. Export one and
    # retain the identities of all excluded frames so the user can spot gaps.
    # Prefer a component large enough to inspect, then maximize frame coverage.
    component_depth = {}
    for model_id, component in models.items():
        registered_ids = set(component.reg_image_ids())
        component_depth[model_id] = sum(a in registered_ids and b in registered_ids for a, b in depth_pairs)

    def rank(item):
        model_id, component = item
        n_images, n_points = component.num_reg_images(), component.num_points3D()
        usable = n_images >= 4 and n_points >= 50 and component_depth[model_id] >= MIN_DEPTH_PAIRS
        return usable, n_images, n_points, -model_id

    model_id, model = max(models.items(), key=rank)
    _check_depth(component_depth[model_id])
    images = sorted((model.image(i) for i in model.reg_image_ids()), key=lambda image: image.name)
    registered = [image.name for image in images]
    count = model.num_points3D()
    if len(registered) < 4 or count < 50:
        raise RuntimeError(
            f"Best connected model registered {len(registered)}/{len(names)} frames "
            f"with {count} points. Need at least 4 registered frames and "
            f"50 triangulated points for a preview. {CAPTURE_HINT}"
        )

    # COLMAP's camera convention is right/down/forward. Use the first registered
    # camera as origin, then rotate 180 degrees about X for the Path App viewer.
    # This preserves handedness. Its up is image-up and scale is arbitrary.
    world_to_view = np.eye(4)
    world_to_view[:3, :] = images[0].cam_from_world().matrix()
    world_to_view[1:3, :] *= -1
    model.update_point_3d_errors()
    warnings = []
    if len(registered) < len(names):
        warnings.append(
            f"Partial hallway preview: the selected model contains {len(registered)} "
            f"of {len(names)} frames. Check unregistered_frame_names for gaps."
        )
    metrics = {
        "input_frames": len(names),
        "registered_frames": len(registered),
        "registration_fraction": len(registered) / len(names),
        "sparse_points": count,
        "nonplanar_verified_pairs": component_depth[model_id],
        "mean_reprojection_error_px": model.compute_mean_reprojection_error(),
        "mean_track_length_frames": model.compute_mean_track_length(),
        "model_count": len(models),
        "model_id": model_id,
        "components": [
            {"model_id": i, "registered_frames": m.num_reg_images(), "sparse_points": m.num_points3D()}
            for i, m in sorted(models.items())
        ],
        "warnings": warnings,
        "first_registered_frame": registered[0],
        "registered_frame_names": registered,
        "unregistered_frame_names": sorted(set(names).difference(registered)),
    }
    return model, metrics, world_to_view


def sparse_points(model, world_to_view):
    """Return triangulated XYZ coordinates in viewer space and matching RGB."""
    points = list(model.points3D.values())
    xyz = np.array([point.xyz for point in points], dtype=np.float64)
    rgb = np.array([point.color for point in points], dtype=np.uint8)
    positions = xyz @ world_to_view[:3, :3].T + world_to_view[:3, 3]
    finite = np.all(np.isfinite(positions), axis=1)
    return positions[finite], rgb[finite]
