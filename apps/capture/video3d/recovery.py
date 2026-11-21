"""Score candidate camera trajectories and recover a joint global solution on CPU."""

from dataclasses import dataclass
from pathlib import Path
import sqlite3
import subprocess

import cv2
import numpy as np
import pycolmap as pc


MIN_DEPTH_PAIRS = 2
MIN_TRACKS_PER_POSE = 20


def depth_pairs(database):
    """Return measured pairs that support 3D geometry beyond a homography."""
    config = pc.TwoViewGeometryConfiguration
    with pc.Database.open(database) as db:
        ids, geometries = db.read_two_view_geometries()
    return [
        pc.pair_id_to_image_pair(pair_id)
        for pair_id, geometry in zip(ids, geometries)
        if geometry.config in (config.CALIBRATED, config.UNCALIBRATED)
        and len(geometry.inlier_matches) >= 30
    ]


@dataclass
class Candidate:
    model: pc.Reconstruction
    id: int
    method: str
    database: Path
    summary: dict
    support: set

    def rank(self):
        # Count frames tied to real triangulated points before counting poses
        # propagated through ambiguous parts of the image sequence.
        return len(self.support), len(self.support) - self.model.num_reg_images(), self.model.num_points3D()


def _alignment_error(model, anchor, common):
    """Similarity-invariant RMS center discrepancy as a fraction of trajectory extent."""
    ids = sorted(common)
    source = np.array([model.image(i).projection_center() for i in ids])
    target = np.array([anchor.model.image(i).projection_center() for i in ids])
    x, y = source - source.mean(0), target - target.mean(0)
    covariance = x.T @ y
    energy = np.sum(x * x)
    extent = np.linalg.norm(np.ptp(target, axis=0))
    if energy <= 0 or extent <= 0 or not np.all(np.isfinite(covariance)):
        return float("inf")
    u, singular, vt = np.linalg.svd(covariance)
    signs = np.array([1., 1., np.sign(np.linalg.det(u @ vt))])
    scaled_rotation = (u * signs) @ vt * ((singular @ signs) / energy)
    residuals = x @ scaled_rotation - y
    return float(np.sqrt(np.mean(np.sum(residuals ** 2, axis=1))) / extent)


def assess(model, model_id, method, database, pairs, anchor=None):
    ids = set(model.reg_image_ids())
    support = {i for i in ids if model.image(i).num_points3D >= MIN_TRACKS_PER_POSE}
    depth = sum(a in ids and b in ids for a, b in pairs)
    model.update_point_3d_errors()
    error = float(model.compute_mean_reprojection_error())
    summary = {
        "model_id": model_id, "method": method, "registered_frames": len(ids),
        "supported_frames": len(support), "sparse_points": model.num_points3D(),
        "nonplanar_verified_pairs": depth,
        "mean_reprojection_error_px": error if np.isfinite(error) else None,
    }
    # Keep the original minimum evidence for incremental components. A global
    # solver can register frames with zero 3D observations; require independent
    # evidence for most poses before spending dense reconstruction on the model.
    if len(ids) < 4 or model.num_points3D() < 50 or depth < MIN_DEPTH_PAIRS:
        summary["rejection"] = "insufficient registered frames, triangulated points or nonplanar pairs"
    elif not np.isfinite(error):
        summary["rejection"] = "nonfinite reprojection error"
    elif method != "incremental" and (error > 4 or len(support) < max(4, .75 * len(ids))):
        summary["rejection"] = "weak 3D support or high reprojection error"
    elif anchor is not None:
        common = anchor.support & support
        if len(common) < min(6, len(anchor.support)):
            summary["rejection"] = "too few supported poses shared with the incremental reference"
        elif len(common) >= 6:
            residual = _alignment_error(model, anchor, common)
            summary["reference_pose_rms_fraction"] = residual if np.isfinite(residual) else None
            if not np.isfinite(residual) or residual > .15:
                summary["rejection"] = "poses disagree with the overlapping incremental reference"
    return Candidate(model, model_id, method, database, summary, support)


def _calibrated_copy(source, dest, anchor):
    with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True) as src:
        with sqlite3.connect(dest) as dst:
            src.backup(dst)
    with pc.Database.open(dest) as db:
        camera = db.read_all_cameras()[0]
        if anchor is not None:
            estimated = next(iter(anchor.model.cameras.values()))
            if (np.all(np.isfinite(estimated.params))
                    and .1 < estimated.mean_focal_length() / max(camera.width, camera.height) < 10
                    and abs(estimated.params[-1]) < 1):
                camera.params = estimated.params.copy()
                camera.has_prior_focal_length = True
                db.update_camera(camera)
                return "incremental"
        return "prior" if camera.has_prior_focal_length else "estimated"


def recover(frames, work, video, video_info, database, anchor, threads, first_model_id):
    """Run the solvers in separate DBs. Interrupted tracking cannot corrupt SIFT geometry."""
    candidates, attempts = [], []
    methods = ["global-sift"]
    if video is not None:
        methods.append("global-tracked")
    for method in methods:
        folder = work / method
        copy = folder / "features.db"
        record = {"method": method}
        try:
            folder.mkdir()
            calibration = _calibrated_copy(database, copy, anchor)
            record["calibration"] = calibration
            if method == "global-tracked":
                if video_info is None:
                    raise ValueError("Video sampling metadata is required for full-rate tracking.")
                from tracking import augment_tracks
                record["tracking"] = augment_tracks(video, frames, video_info, copy, folder)
            pairs = depth_pairs(copy)
            if len(pairs) < MIN_DEPTH_PAIRS:
                record["error"] = "Insufficient parallax after verification. A stationary pan cannot recover depth."
            else:
                options = pc.GlobalPipelineOptions(num_threads=threads, random_seed=19, min_model_size=4)
                options.mapper.global_positioning.use_gpu = False
                options.mapper.bundle_adjustment.ceres.use_gpu = False
                refine = calibration == "estimated"
                options.mapper.bundle_adjustment.refine_focal_length = refine
                options.mapper.bundle_adjustment.refine_extra_params = refine
                output = folder / "models"
                output.mkdir()
                models = pc.global_mapping(copy, frames, output, options=options)
                record["components"] = []
                for original_id, model in sorted(models.items()):
                    new_id = first_model_id + len(candidates)
                    (output / str(original_id)).rename(work / "models" / str(new_id))
                    c = assess(model, new_id, method, copy, pairs, anchor)
                    candidates.append(c)
                    record["components"].append(c.summary)
                if not models:
                    record["error"] = "no connected global model"
        except (RuntimeError, OSError, ValueError, sqlite3.Error, cv2.error, subprocess.SubprocessError) as exc:
            record["error"] = str(exc)
        attempts.append(record)
    return candidates, attempts
