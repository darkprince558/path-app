"""Add corroborated RGB depth samples in a bounded time window of the original mesh."""

import ctypes
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np
import pycolmap
from scipy.spatial import cKDTree

from mesh import saved_scene
from mesh_geometry import _accessor, _item, _read_glb, _source_arrays
from plane_views import ordered_poses, training_photo


# These bounds cap the number of reference views, working image size, and stored
# candidates even for long, high-resolution phone videos.
MAX_REFERENCES = 40
LONG_EDGE = 256
MAX_POINTS_PER_VIEW = 5000
OFFSETS = (1, 2, 3, 4, 6)


@dataclass
class Camera:
    path: Path
    native_shape: tuple
    size: tuple
    intrinsic: np.ndarray
    rotation: np.ndarray
    center: np.ndarray
    observations: int
    seconds: float
    weak: bool = False


def _cameras(run, fps, weak_names):
    folder = run / "openmvs/colmap"
    image_dir = (folder / "images").resolve()
    model = pycolmap.Reconstruction(folder / "sparse")
    poses = ordered_poses(model)
    cameras = []
    for im in poses:
        calib = model.cameras[im.camera_id]
        match = re.fullmatch(r"frame-(\d+)\.[^.]+", im.name)
        if calib.model_name != "PINHOLE" or not match or int(match[1]) < 1:
            raise ValueError("Depth sweeping requires numbered, undistorted pinhole frames.")
        path = (image_dir / im.name).resolve()
        if not path.is_relative_to(image_dir):
            raise ValueError("Calibrated image path leaves the saved image directory.")
        scale = min(1.0, LONG_EDGE / max(calib.width, calib.height))
        w, h = max(1, round(calib.width * scale)), max(1, round(calib.height * scale))
        k = np.asarray(calib.params, dtype=np.float64) * np.array([w/calib.width, h/calib.height] * 2)
        rotation = im.cam_from_world().rotation.matrix()
        center = im.projection_center()
        if not (np.isfinite(k).all() and (k[:2] > 0).all() and np.isfinite(rotation).all()
                and np.isfinite(center).all()):
            raise ValueError("Non-finite or invalid saved camera calibration.")
        cameras.append(Camera(path, (calib.height, calib.width), (w, h), k, rotation, center,
                              im.num_points3D, (int(match[1])-1) / fps, im.name in weak_names))
    return cameras


def _baseline(path, transform):
    doc, binary = _read_glb(path)
    views = _source_arrays(doc, binary, path.parent)
    if len(doc["nodes"]) != 1 or _item(doc["scenes"], doc.get("scene", 0))["nodes"] != [0]:
        raise ValueError("Expected the original viewer mesh with a single flat node.")
    node = doc["nodes"][0]
    if any(key in node for key in ("matrix", "translation", "rotation", "scale", "children")):
        raise ValueError("Expected the original viewer mesh in viewer coordinates.")
    parts = []
    for prim in _item(doc["meshes"], node["mesh"])["primitives"]:
        xyz = _accessor(doc, views, prim["attributes"]["POSITION"], "VEC3", {5126})
        indices = _accessor(doc, views, prim["indices"], "SCALAR", {5121, 5123, 5125})
        if (prim.get("mode", 4) != 4 or indices.size % 3 or not np.isfinite(xyz).all()
                or indices.max() >= len(xyz) or max(indices.size, len(xyz) * 3) > 2**31-1):
            raise ValueError("Invalid triangle geometry in the original viewer mesh.")
        faces = np.ascontiguousarray(indices.reshape(-1, 3), np.int32)
        two_sided = ("material" in prim and
                     _item(doc["materials"], prim["material"]).get("doubleSided", False))
        world = (xyz - transform[:3, 3]) @ transform[:3, :3]
        parts.append((world, faces, bool(two_sided)))
    if not parts:
        raise ValueError("Expected triangle primitives in the original viewer mesh.")
    return parts


def _rasterizer(directory, compiler):
    library = Path(directory) / "depth.so"
    source = Path(__file__).with_name("plane_sweep_zbuffer.c")
    flag = "-dynamiclib" if sys.platform == "darwin" else "-shared"
    subprocess.run([compiler, "-std=c99", "-O2", flag, "-fPIC", str(source), "-lm", "-o", str(library)],
                   check=True, capture_output=True, timeout=30)
    fn = ctypes.CDLL(str(library)).render_depth
    f32 = np.ctypeslib.ndpointer(np.float32, flags="C_CONTIGUOUS")
    fn.argtypes = [f32, np.ctypeslib.ndpointer(np.int32, flags="C_CONTIGUOUS"), ctypes.c_int,
                   np.ctypeslib.ndpointer(np.float64, flags="C_CONTIGUOUS"),
                   ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_double, f32]
    fn.restype = None
    return fn


def _mesh_depth(fn, parts, cam, near):
    w, h = cam.size
    depth = np.full((h, w), np.inf, np.float32)
    for vertices, faces, two_sided in parts:
        xyz = np.ascontiguousarray((vertices - cam.center) @ cam.rotation.T, np.float32)
        fn(xyz, faces, len(faces), cam.intrinsic, w, h, two_sided, near, depth)
    return depth


def _gray(cam):
    img = cv2.imread(str(cam.path), cv2.IMREAD_GRAYSCALE)
    if img is None or img.shape != cam.native_shape:
        raise ValueError(f"Unreadable or incorrectly sized calibrated photo: {cam.path.name}")
    return cv2.resize(img, cam.size, interpolation=cv2.INTER_AREA).astype(np.float32)


def _groups(cameras, i):
    # Hold out the same sorted poses as the texture validator. No RGB from a
    # held-out pose enters the sweep, either as a reference or a source.
    return [[j for step in OFFSETS if 0 <= (j := i + sign * step) < len(cameras)
             and training_photo(j, cameras[j].observations, cameras[j].weak)] for sign in (-1, 1)]


def _sample(array):
    return cv2.boxFilter(array, -1, (5, 5), normalize=True)


def _pixels(cam, xyz):
    with np.errstate(divide="ignore", invalid="ignore"):
        u = cam.intrinsic[0] * xyz[..., 0] / xyz[..., 2] + cam.intrinsic[2] - 0.5
        v = cam.intrinsic[1] * xyz[..., 1] / xyz[..., 2] + cam.intrinsic[3] - 0.5
    return u, v


def _side_depth(ref, sources, source_images, ref_gray, directions, depths):
    mean = _sample(ref_gray)
    variance = np.maximum(_sample(ref_gray * ref_gray) - mean * mean, 0)
    costs = np.empty((len(depths), *ref_gray.shape), np.float32)
    projected = [((directions @ cam.rotation.T).astype(np.float32),
                  ((ref.center-cam.center) @ cam.rotation.T).astype(np.float32)) for cam in sources]
    for index, depth in enumerate(depths):
        errors = []
        for cam, gray, (rotated, offset) in zip(sources, source_images, projected):
            xyz = rotated * depth + offset
            u, v = _pixels(cam, xyz)
            warped = cv2.remap(gray, u.astype(np.float32), v.astype(np.float32), cv2.INTER_LINEAR)
            avg = _sample(warped)
            var = np.maximum(_sample(warped * warped) - avg * avg, 0)
            cov = _sample(ref_gray * warped) - mean * avg
            cost = 1 - np.clip(cov / (np.sqrt(variance * var) + 0.3), -1, 1)
            w, h = cam.size
            valid = (u >= 3) & (u < w-3) & (v >= 3) & (v < h-3) & (xyz[..., 2] > 0) & (var > 9)
            errors.append(np.where(valid, cost, 2.0))
        costs[index] = np.sort(errors, axis=0)[:2].mean(axis=0)
    best = costs.argmin(axis=0)
    score = np.take_along_axis(costs, best[None], axis=0)[0]
    other = np.full_like(score, 3.0)
    for index, cost in enumerate(costs):
        np.minimum(other, cost, out=other, where=np.abs(best - index) >= 3)
    z = depths[best]
    farthest = max(sources, key=lambda cam: np.linalg.norm(cam.center - ref.center))
    second_ray = directions * z[..., None] + (ref.center - farthest.center)
    with np.errstate(divide="ignore", invalid="ignore"):
        angle_sine = (np.linalg.norm(np.cross(directions, second_ray), axis=2)
                      / (np.linalg.norm(directions, axis=2) * np.linalg.norm(second_ray, axis=2)))
    keep = ((variance > 16) & (score < 0.2) & (other > score + 0.025)
            & (best > 0) & (best < len(depths)-1) & (angle_sine > 0.03))
    return z, keep


def _sweep_reference(i, cameras, groups, gray, mesh_depth, depths, extent):
    ref = cameras[i]
    w, h = ref.size
    x, y = np.meshgrid(np.arange(w, dtype=np.float32)+0.5, np.arange(h, dtype=np.float32)+0.5)
    fx, fy, cx, cy = ref.intrinsic
    rays = np.stack(((x-cx)/fx, (y-cy)/fy, np.ones_like(x)), axis=-1)
    directions = (rays @ ref.rotation).astype(np.float32)
    image = gray(i)
    estimates = [_side_depth(ref, [cameras[j] for j in group], [gray(j) for j in group],
                             image, directions, depths) for group in groups]
    (a, left), (b, right) = estimates
    ok = left & right & (np.abs(np.log(a/b)) < np.log(1.2))
    missing = ok & ~np.isfinite(mesh_depth(i))
    world = directions[missing] * np.sqrt(a[missing] * b[missing])[:, None] + ref.center
    veto = np.zeros(len(world), dtype=bool)
    for j in groups[0] + groups[1]:
        if not len(world):
            break
        cam = cameras[j]
        xyz = (world-cam.center) @ cam.rotation.T
        u, v = _pixels(cam, xyz)
        u, v = np.rint(u), np.rint(v)
        w, h = cam.size
        indices = np.flatnonzero((xyz[:, 2] > 0) & (u >= 0) & (u < w) & (v >= 0) & (v < h))
        prior = mesh_depth(j)[v[indices].astype(int), u[indices].astype(int)]
        # Filling here would hide a farther original surface visible from this camera.
        veto[indices] |= np.isfinite(prior) & (prior > xyz[indices, 2] * 1.15 + extent * 0.006)
    return world[~veto], {"matched_pixels": int(ok.sum()), "missing_pixels": len(world),
                          "free_space_veto": int(veto.sum())}


def _repeated(by_reference, radius):
    trees = {i: cKDTree(points) for i, points in by_reference.items() if len(points)}
    result = {}
    for i in trees:
        points = by_reference[i]
        keep = np.zeros(len(points), dtype=bool)
        for j, tree in trees.items():
            if abs(i - j) >= 2:
                dist = tree.query(points, k=1, distance_upper_bound=radius)[0]
                keep |= np.isfinite(dist)
        result[i] = points[keep]
    return result


def sweep_anchors(run, start_seconds, end_seconds):
    """Return viewer-space XYZ depth anchors, and JSON-safe counts per reference view.

    Pass None for both endpoints to skip the optional depth sweep. A supported
    anchor needs two earlier and two later matching photographs and a repeat
    depth estimate from another reference. Reconstruction units are arbitrary.
    """
    empty = np.empty((0, 3), np.float64)
    stats = {"status": "skipped", "anchors": 0, "views": []}
    if start_seconds is None and end_seconds is None:
        return empty, dict(stats, reason="no turn interval")
    if (start_seconds is None or end_seconds is None or not np.isfinite([start_seconds, end_seconds]).all()
            or not 0 <= start_seconds <= end_seconds):
        raise ValueError("Expected a finite, ordered turn interval in seconds.")
    run = Path(run).resolve()
    source, transform = saved_scene(run)
    fps = source.get("video", {}).get("sample_fps")
    if not isinstance(fps, (int, float)) or not np.isfinite(fps) or fps <= 0:
        raise ValueError("Saved capture has no valid sample rate.")
    cameras = _cameras(run, fps, set(source.get("reconstruction", {}).get("weak_frame_names", [])))
    refs = [i for i, cam in enumerate(cameras) if start_seconds <= cam.seconds <= end_seconds
            and training_photo(i, cam.observations, cam.weak)]
    if len(refs) > MAX_REFERENCES:
        refs = [refs[j] for j in np.linspace(0, len(refs)-1, MAX_REFERENCES, dtype=int)]
    groups = {i: _groups(cameras, i) for i in refs}
    refs = [i for i in refs if all(len(g) >= 2 for g in groups[i])]
    stats.update(interval_seconds=[float(start_seconds), float(end_seconds)],
                 heldout_rule="sorted registered index % 5 == 2 is never decoded",
                 source_indices=sorted({j for i in refs for g in groups[i] for j in g}))
    if len(refs) < 2:
        return empty, dict(stats, reason="insufficient reference or neighboring poses")
    extent = float(np.linalg.norm(np.ptp([cam.center for cam in cameras], axis=0)))
    if extent < 1e-8:
        return empty, dict(stats, reason="insufficient camera translation")
    compiler = shutil.which("cc")
    if not compiler:
        return empty, dict(stats, reason="missing C compiler for mesh-depth rendering")

    parts = _baseline(run / "mesh/hallway.glb", transform)
    depths = np.geomspace(0.06 * extent, 3.84 * extent, 51)
    by_reference = {}
    with tempfile.TemporaryDirectory(prefix="path-depth-") as temp:
        fn = _rasterizer(temp, compiler)
        gray = lru_cache(maxsize=20)(lambda i: _gray(cameras[i]))
        mesh_depth = lru_cache(maxsize=20)(lambda i: _mesh_depth(fn, parts, cameras[i], extent * 0.000085))
        for i in refs:
            world, counts = _sweep_reference(i, cameras, groups[i], gray, mesh_depth, depths, extent)
            if len(world) > MAX_POINTS_PER_VIEW:
                world = world[np.linspace(0, len(world)-1, MAX_POINTS_PER_VIEW, dtype=int)]
            by_reference[i] = world
            stats["views"].append(dict(index=i, seconds=cameras[i].seconds, candidates=len(world), **counts))
    repeated = _repeated(by_reference, extent * 0.0085)
    for v in stats["views"]:
        v["repeated_anchors"] = len(repeated.get(v["index"], []))
    if not repeated:
        return empty, dict(stats, status="complete", candidates=0)
    xyz = np.concatenate(list(repeated.values())) @ transform[:3, :3].T + transform[:3, 3]
    return xyz, dict(stats, status="complete", anchors=len(xyz), candidates=sum(map(len, by_reference.values())))
