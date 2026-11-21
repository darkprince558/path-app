"""Recover camera poses and colored feature tracks from sequential video frames."""

import os
from pathlib import Path

import numpy as np
import pycolmap

from recovery import MIN_DEPTH_PAIRS, MIN_TRACKS_PER_POSE, assess, depth_pairs, recover


CAPTURE_HINT = (
    "Walk slowly past textured features and keep them in view from several "
    "positions. Include sideways movement, especially when filming a turn."
)


def _check_depth(pair_count):
    if pair_count < MIN_DEPTH_PAIRS:
        raise RuntimeError(
            f"Insufficient parallax: {pair_count} frame pairs show reliable depth "
            f"beyond a single plane (need {MIN_DEPTH_PAIRS}). A stationary pan cannot "
            f"recover hallway depth. {CAPTURE_HINT}"
        )


def reconstruct(frames: Path, work: Path, *, video=None, video_info=None, mapping="auto"):
    """Map a single-camera sequence of zero-padded JPEGs in a fresh workspace."""
    if mapping not in {"auto", "incremental", "global"}:
        raise ValueError("Mapping must be auto, incremental or global.")
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
    pairs = depth_pairs(database)
    attempts = []
    models = {}
    if len(pairs) >= MIN_DEPTH_PAIRS:
        options = pycolmap.IncrementalPipelineOptions(num_threads=threads, min_model_size=4)
        options.mapper.init_min_tri_angle = 5.0
        try:
            models = pycolmap.incremental_mapping(database, frames, models_dir, options=options)
        except RuntimeError as exc:
            if mapping == "incremental":
                raise
            attempts.append({"method": "incremental", "error": str(exc)})
    elif mapping == "incremental" or video is None:
        _check_depth(len(pairs))
    else:
        # Full-rate optical flow can still establish new nonplanar correspondences.
        attempts.append({"method": "incremental", "error": "insufficient SIFT parallax evidence"})
    components = [assess(model, i, "incremental", database, pairs) for i, model in models.items()]
    eligible = [c for c in components if "rejection" not in c.summary]
    # Keep the largest verified incremental component as the lens/geometry reference.
    anchor = max(eligible, key=lambda c: (c.model.num_reg_images(), c.model.num_points3D()), default=None)
    chosen = anchor
    need_recovery = anchor is None or len(anchor.support) < len(names)
    if mapping == "global" or (mapping == "auto" and video is not None and need_recovery):
        # Account for any partial output left by an interrupted mapper.
        first_id = 1 + max((int(p.name) for p in models_dir.iterdir() if p.name.isdecimal()), default=-1)
        extra, history = recover(frames, work, video, video_info, database, anchor, threads, first_id)
        components.extend(extra)
        attempts.extend(history)
        for candidate in extra:
            if "rejection" not in candidate.summary and (chosen is None or candidate.rank() > chosen.rank()):
                chosen = candidate
    if chosen is None:
        reasons = list(dict.fromkeys(a["error"].rstrip(".") for a in attempts if a.get("error")))
        detail = " " + ". ".join(reasons) + "." if reasons else ""
        raise RuntimeError(f"No supported camera trajectory could be triangulated from {len(names)} frames."
                           f"{detail} {CAPTURE_HINT}")

    model, model_id = chosen.model, chosen.id
    if chosen.method != "incremental":
        model.extract_colors_for_all_images(frames, threads)
        model.write(models_dir / str(model_id))
    images = sorted((model.image(i) for i in model.reg_image_ids()), key=lambda image: image.name)
    registered = [image.name for image in images]
    weak = [image.name for image in images if image.image_id not in chosen.support]
    count = model.num_points3D()

    # COLMAP's camera convention is right/down/forward. Use the first registered
    # camera as origin, then rotate 180 degrees about X for the Path App viewer.
    # This preserves handedness. Its up is image-up and scale is arbitrary.
    world_to_view = np.eye(4)
    world_to_view[:3, :] = images[0].cam_from_world().matrix()
    world_to_view[1:3, :] *= -1
    warnings = []
    if weak:
        warnings.append(f"{len(weak)} registered camera pose(s) have fewer than {MIN_TRACKS_PER_POSE} "
                        "triangulated observations. Inspect weak_frame_names before using their geometry.")
    for attempt in attempts:
        if "error" in attempt:
            warnings.append(f"{attempt['method']} attempt: {attempt['error']}")
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
        "nonplanar_verified_pairs": chosen.summary["nonplanar_verified_pairs"],
        "mapping_requested": mapping,
        "mapping_method": chosen.method,
        "recovery_attempts": attempts,
        "feature_database": str(chosen.database.relative_to(work)),
        "supported_frames": len(chosen.support),
        "weak_frame_names": weak,
        "mean_reprojection_error_px": model.compute_mean_reprojection_error(),
        "mean_track_length_frames": model.compute_mean_track_length(),
        "model_count": len(components),
        "model_id": model_id,
        "components": [c.summary for c in components],
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
