"""Exclude proposed surfaces hit by a measured feature ray before its known landmark."""

from pathlib import Path

import numpy as np
import pycolmap
from scipy.spatial import cKDTree

from mesh import saved_scene
from plane_fit import _baseline_triangles
from plane_views import ordered_poses, reserved_photo


class TriangleTree:
    """Axis-aligned bounds around a midpoint kd-tree with exact, double-sided leaf tests."""

    def __init__(self, triangles):
        self.tris = np.ascontiguousarray(triangles, dtype=np.float64)
        tree = cKDTree(self.tris.mean(axis=1), leafsize=24)
        self.root = self._bounds(tree.tree)

    def _bounds(self, node):
        if node.lesser is None:
            ids = node.indices
            tris = self.tris[ids]
            return tris.min(axis=(0, 1)), tris.max(axis=(0, 1)), ids, None
        left, right = self._bounds(node.lesser), self._bounds(node.greater)
        return np.minimum(left[0], right[0]), np.maximum(left[1], right[1]), left, right

    def hits(self, origin, directions, limits):
        """Yield ray IDs, face IDs and depths for every intersection in (0, limit)."""
        inv = np.divide(1., directions, where=directions != 0, out=np.zeros_like(directions))
        stack = [(self.root, np.arange(len(directions)))]
        while stack:
            (lo, hi, left, right), rays = stack.pop()
            parallel = directions[rays] == 0
            t0, t1 = (lo - origin) * inv[rays], (hi - origin) * inv[rays]
            start = np.where(parallel, -np.inf, np.minimum(t0, t1)).max(axis=1)
            end = np.where(parallel, np.inf, np.maximum(t0, t1)).min(axis=1)
            outside = (parallel & ((origin < lo) | (origin > hi))).any(axis=1)
            rays = rays[(~outside) & (np.maximum(0, start) <= np.minimum(limits[rays], end))]
            if not len(rays):
                continue
            if right is not None:
                stack.extend(((left, rays), (right, rays)))
                continue
            triangles = self.tris[left]
            a, b = triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
            arrows = directions[rays, None, :]
            cross = np.cross(arrows, b)
            determinant = np.einsum("rti,ti->rt", cross, a)
            threshold = 32 * np.finfo(float).eps * np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1)
            valid = np.abs(determinant) > threshold * np.linalg.norm(arrows, axis=2)
            inverse = np.divide(1., determinant, out=np.zeros_like(determinant), where=valid)
            offset = origin - triangles[:, 0]
            u = np.einsum("rti,ti->rt", cross, offset) * inverse
            q = np.cross(offset, a)
            v = (directions[rays] @ q.T) * inverse
            depth = np.einsum("ti,ti->t", q, b) * inverse
            valid &= (u >= -1e-10) & (v >= -1e-10) & (u + v <= 1 + 1e-10)
            rid, fid = np.nonzero(valid & (depth > 0) & (depth < limits[rays, None]))
            if len(rid):
                yield rays[rid], left[fid], depth[rid, fid]


def _blocked_on_rays(base, patch, origin, directions, limits):
    hits = list(patch.hits(origin, directions, limits))
    if not hits:
        return np.empty(0, np.intp), 0, 0
    ray_ids, face_ids, depth = (np.concatenate(items) for items in zip(*hits))
    unique, back = np.unique(ray_ids, return_inverse=True)
    closest_base = np.full(len(unique), np.inf)
    for ray, _, distance in base.hits(origin, directions[unique], limits[unique]):
        np.minimum.at(closest_base, ray, distance)
    # A fill hidden by the original mesh cannot worsen that ray. Include every blocking
    # patch face; deleting just the nearest would expose another invalid face behind it.
    new_block = depth < closest_base[back] - 1e-8 * np.maximum(1., depth)
    return np.unique(face_ids[new_block]), len(np.unique(ray_ids[new_block])), int((~new_block).sum())


def reject_occlusions(run, base, vertices, faces):
    """Return a face keep mask and counts. Geometry uses all views; this reads no photos."""
    vertices, faces = np.asarray(vertices, dtype=float), np.asarray(faces)
    if (vertices.ndim != 2 or vertices.shape[1] != 3 or not np.isfinite(vertices).all()
            or faces.ndim != 2 or faces.shape[1] != 3 or faces.dtype.kind not in 'iu'
            or (len(faces) and (faces.min() < 0 or faces.max() >= len(vertices)))):
        raise ValueError('Invalid plane triangles for observed-ray validation.')
    keep = np.ones(len(faces), dtype=bool)
    stats = dict(input_faces=len(faces), checked_rays=0, contributing_cameras=0,
                 conflicting_rays=0, baseline_hidden_hits=0, vetoed_faces=0,
                 withheld_rgb_conflicting_rays=0, minimum_track_length=4,
                 maximum_track_reprojection_error=1.5, relative_depth_margin=.05)
    if not len(faces):
        return keep, stats
    run = Path(run)
    _, transform = saved_scene(run)
    model = pycolmap.Reconstruction(run / 'openmvs/colmap/sparse')
    images = ordered_poses(model)
    positions = np.array([im.projection_center() for im in images])
    if not len(positions):
        raise ValueError('No registered camera geometry for plane validation.')
    tolerance = .003 * np.linalg.norm(np.ptp(positions, axis=0))
    stats['absolute_depth_margin'] = float(tolerance)
    trusted = {i: p.xyz for i, p in model.points3D.items()
               if p.track.length() >= stats['minimum_track_length']
               and p.error <= stats['maximum_track_reprojection_error']}
    mesh = TriangleTree(_baseline_triangles(base))
    patch = TriangleTree(vertices[faces])
    for index, image in enumerate(images):
        observations = [pt for pt in image.get_observation_points2D() if pt.point3D_id in trusted]
        if not observations:
            continue
        pose, camera = image.cam_from_world(), model.cameras[image.camera_id]
        if camera.model_name != 'PINHOLE':
            raise ValueError('Observed-ray validation requires the saved undistorted cameras.')
        rotation = pose.rotation.matrix()
        xyz = np.asarray([trusted[pt.point3D_id] for pt in observations])
        depth = xyz @ rotation[2] + pose.translation[2]
        xy = np.asarray([pt.xy for pt in observations])
        good = (depth > 0) & np.isfinite(depth) & np.isfinite(xy).all(axis=1)
        if not good.any():
            continue
        normalized = (xy[good] - camera.params[2:]) / camera.params[:2]
        directions = np.column_stack((normalized, np.ones(len(normalized)))) @ rotation @ transform[:3, :3].T
        origin = transform[:3, :3] @ image.projection_center() + transform[:3, 3]
        # Leave a scale-relative uncertainty band around the triangulated depth.
        # A raw 2D observation provides the ray direction independently of its stored 3D point.
        limit = depth[good] - np.maximum(tolerance, stats['relative_depth_margin'] * depth[good])
        blocked, conflicts, hidden = _blocked_on_rays(mesh, patch, origin, directions, limit)
        keep[blocked] = False
        stats['contributing_cameras'] += 1
        stats['checked_rays'] += len(limit)
        stats['conflicting_rays'] += conflicts
        stats['baseline_hidden_hits'] += hidden
        if reserved_photo(index):
            stats['withheld_rgb_conflicting_rays'] += conflicts
    stats['vetoed_faces'] = int((~keep).sum())
    return keep, stats
