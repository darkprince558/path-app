"""Fit oriented planes and propose bounded patches between measured coplanar samples."""

from pathlib import Path

import cv2
import numpy as np
from scipy.spatial import cKDTree, Delaunay, QhullError

from mesh_geometry import _accessor, _read_glb, _read_ply, _source_arrays


def _baseline_triangles(path):
    path = Path(path).resolve()
    doc, binary = _read_glb(path)
    views = _source_arrays(doc, binary, path.parent)
    # Path's exporter bakes the world transform into positions on one identity node.
    if doc["scenes"][doc.get("scene", 0)]["nodes"] != [0] or len(doc["nodes"]) != 1:
        raise ValueError("Expected a Path mesh with a single viewer-space node")
    node = doc["nodes"][0]
    if any(k in node for k in ("matrix", "translation", "rotation", "scale", "children")):
        raise ValueError("The baseline positions must already be in the viewer coordinate frame")
    result = []
    for primitive in doc["meshes"][node["mesh"]]["primitives"]:
        if primitive.get("mode", 4) != 4:
            raise ValueError("Expected triangle primitives")
        positions = _accessor(doc, views, primitive["attributes"]["POSITION"], "VEC3", {5126})
        ids = _accessor(doc, views, primitive["indices"], "SCALAR", {5121, 5123, 5125}).ravel()
        if not len(ids) or len(ids) % 3 or ids.max() >= len(positions) or not np.isfinite(positions).all():
            raise ValueError("Invalid triangle geometry in the baseline GLB")
        result.append(positions[ids].reshape(-1, 3, 3))
    if not result:
        raise ValueError("The baseline GLB has no triangle primitives")
    return np.concatenate(result)


def _plane_samples(points, step):
    # Equal spatial votes keep a small, densely photographed object from dominating a wall.
    cells = np.floor((points - points.min(axis=0)) / step).astype(np.int64)
    _, keep = np.unique(cells, axis=0, return_index=True)
    sample = points[keep]
    if len(sample) < 50:
        return sample[:0], sample[:0]
    neighbors = cKDTree(sample).query(sample, k=14, workers=4)[1]
    patches = sample[neighbors]
    centered = patches - patches.mean(axis=1, keepdims=True)
    eigen, axes = np.linalg.eigh(np.swapaxes(centered, 1, 2) @ centered)
    reliable = ((eigen[:, 0] < .10 * eigen[:, 1]) & (eigen[:, 1] > .045 * eigen[:, 2])
                & (np.linalg.norm(patches[:, -1] - sample, axis=1) < 8 * step))
    return sample[reliable], axes[reliable, :, 0]


def _fit_planes(samples, normals, centers, scale):
    """Seed with local normals and refit consensus planes with total least squares."""
    tol = scale * .003
    rng = np.random.default_rng(31)
    remaining = np.arange(len(samples))
    found = []
    for _ in range(24):
        if len(remaining) < 70:
            break
        indices = rng.choice(remaining, min(384, len(remaining)), replace=False)
        ns = normals[indices]
        ds = np.einsum('ij,ij->i', samples[indices], ns)
        upright = (abs(ns[:, 1]) < .29) | (abs(ns[:, 1]) > .93)
        ns, ds = ns[upright], ds[upright]
        if not len(ns):
            break
        scoring = rng.choice(remaining, min(4800, len(remaining)), replace=False)
        ranks = (np.abs(samples[scoring] @ ns.T - ds) < tol) & (np.abs(normals[scoring] @ ns.T) > .93)
        k = np.argmax(ranks.sum(axis=0))
        normal, offset = ns[k], ds[k]
        active = samples[remaining]
        for _ in range(3):
            group = (np.abs(active @ normal - offset) < tol) & (abs(normals[remaining] @ normal) > .92)
            if group.sum() < 55:
                break
            plane_points = active[group]
            center = np.mean(plane_points, axis=0)
            _, _, axes = np.linalg.svd(plane_points - center, full_matrices=False)
            normal = axes[-1]
            offset = center @ normal
        if group.sum() < 55:
            break
        anchors = remaining[group]
        remaining = remaining[~group]
        if normal[1] < 0:
            normal, offset = -normal, -offset
        if normal[1] < .29:
            kind = "wall"
        elif normal[1] > .93 and np.percentile(centers @ normal - offset, 15) > scale * .035:
            kind = "floor"
        else:
            continue
        p = samples[anchors]
        width = np.linalg.svd(p - p.mean(axis=0), compute_uv=False)[1] / np.sqrt(len(p))
        if width >= scale * .012:
            found.append((normal, float(offset), anchors, kind))
    return found


def _sparse_planes(points, centers, scale):
    # A sparse corner may be constrained by many long feature tracks even where
    # the denser depth-map fusion failed. Each tile votes by independent 3D cells.
    bins = np.floor(points / (scale * .005)).astype(np.int64)
    samples = points[np.unique(bins, axis=0, return_index=True)[1]]
    tiles = np.floor(samples[:, [0, 2]] / (.36 * scale)).astype(np.int64)
    names, counts = np.unique(tiles, axis=0, return_counts=True)
    rng = np.random.default_rng(43)
    proposals = []
    for name in names[counts >= 45]:
        center = (name + .5) * scale * .36
        local = samples[(abs(samples[:, [0, 2]] - center) < .205 * scale).all(axis=1)]
        for _ in range(5):
            if len(local) < 38:
                break
            triplets = local[rng.integers(0, len(local), (300, 3))]
            normals = np.cross(triplets[:, 1] - triplets[:, 0], triplets[:, 2] - triplets[:, 0])
            norm = np.linalg.norm(normals, axis=1)
            normals /= np.maximum(norm[:, None], 1e-12)
            mask = ((norm > (.013 * scale)**2)
                    & ((abs(normals[:, 1]) < .26) | (abs(normals[:, 1]) > .94)))
            normals = normals[mask]
            if not len(normals):
                break
            offsets = np.einsum('ij,ij->i', normals, triplets[mask, 0])
            matches = abs(local @ normals.T - offsets) < scale * .0022
            best = np.argmax(matches.sum(axis=0))
            inside = matches[:, best]
            if inside.sum() < 34:
                break
            anchors = local[inside]
            center3 = np.mean(anchors, axis=0)
            _, extent, axes = np.linalg.svd(anchors - center3, full_matrices=False)
            normal = axes[-1]
            if normal[1] < 0:
                normal = -normal
            offset = center3 @ normal
            local = local[~inside]
            if extent[1] / np.sqrt(len(anchors)) < .012 * scale:
                continue
            if normal[1] < .29:
                kind = 'wall'
            elif normal[1] > .93 and np.percentile(centers @ normal - offset, 15) > .035 * scale:
                kind = 'floor'
            else:
                continue
            proposals.append((normal, float(offset), anchors, kind))
    return proposals


def _basis(normal):
    tangent = np.eye(3)[np.argmin(np.abs(normal))]
    tangent -= (tangent @ normal) * normal
    tangent /= np.linalg.norm(tangent)
    return np.column_stack((tangent, np.cross(normal, tangent)))


def _propose_chart(anchors, normal, offset, existing, cell, max_edge, tol):
    """A local Delaunay support footprint clipped against the existing triangle surface."""
    basis = _basis(normal)
    uv = anchors @ basis
    lower = uv.min(axis=0) - 2 * cell
    coords = (uv - lower) / cell
    shape = np.ceil(coords.max(axis=0) + 3).astype(int)
    if np.max(shape) > 2048 or np.prod(shape) > 1_000_000:
        return None
    # Disconnected patch groups must have a nearby measured path within each chart.
    # Bridge a hole within a patch without inventing a sheet between two separate panels.
    grid = np.zeros(tuple(shape[::-1]), np.uint8)
    grid[coords[:, 1].astype(int), coords[:, 0].astype(int)] = 1
    _, groups = cv2.connectedComponents(cv2.dilate(grid, np.ones((3, 3), np.uint8)), connectivity=8)
    labels = groups[coords[:, 1].astype(int), coords[:, 0].astype(int)]
    # Quantize repeated projected points and interpolate only inside bounded support triangles.
    _, unique = np.unique(np.round(coords * 4).astype(int), axis=0, return_index=True)
    coords, labels = coords[unique], labels[unique]
    try:
        simplices = Delaunay(coords).simplices
    except QhullError:
        return None
    tris = coords[simplices]
    lengths = np.linalg.norm(tris - np.roll(tris, 1, axis=1), axis=2)
    admissible = (lengths.max(axis=1) <= max_edge / cell) & (labels[simplices] == labels[simplices][:, :1]).all(axis=1)
    # Supersample the chart. A cell triangle must lie fully in the support footprint
    # and clear the baseline mesh; this conservatively leaves a narrow seam at its edges.
    factor = 4
    mask = np.zeros(tuple(shape[::-1] * factor), np.uint8)
    for tri in np.rint(tris[admissible] * factor).astype(np.int32):
        cv2.fillConvexPoly(mask, tri, 1)
    signed = existing @ normal - offset
    near = (signed.min(axis=1) <= 2.5 * tol) & (signed.max(axis=1) >= -2.5 * tol)
    covered = np.zeros_like(mask)
    old = (existing[near] @ basis - lower) * (factor / cell)
    for tri in np.rint(old).astype(np.int32):
        cv2.fillConvexPoly(covered, tri, 1)
    free = (mask & ~covered).astype(bool)
    cr, cc = np.nonzero(grid | (mask[::factor, ::factor] > 0))
    cr, cc = cr.astype(int), cc.astype(int)
    within = (cr < shape[1] - 1) & (cc < shape[0] - 1)
    cr, cc = cr[within], cc[within]
    faces = []
    for upper in (False, True):
        accept = np.ones(len(cr), bool)
        for y in range(factor + 1):
            for x in range(factor + 1):
                if (x + y >= factor if upper else x + y <= factor):
                    accept &= free[cr * factor + y, cc * factor + x]
        row, col = cr[accept], cc[accept]
        if not len(row):
            continue
        origin = np.column_stack((col, row))
        corners = np.array([[1, 1], [0, 1], [1, 0]] if upper else [[0, 0], [1, 0], [0, 1]])
        faces.append(origin[:, None, :] + corners)
    if not faces:
        return None
    chart, idx = np.unique(np.concatenate(faces).reshape(-1, 2), axis=0, return_inverse=True)
    return (chart * cell + lower) @ basis.T + offset * normal, idx.reshape(-1, 3)


def _voxel_sample(points, cell):
    tiles = np.floor(points / cell).astype(np.int64)
    return points[np.unique(tiles, axis=0, return_index=True)[1]]


def _landmarks(values, name, cell):
    if values is None:
        return np.empty((0, 3))
    values = np.asarray(values, dtype=float)
    if values.ndim != 2 or values.shape[1] != 3 or not np.isfinite(values).all():
        raise ValueError(f"Expected finite {name} landmarks in the viewer frame")
    return _voxel_sample(values, cell * .5)


def propose(points_path, mesh_path, camera_centers, *, sparse_points=None, corroborating_points=None,
            max_gap_fraction=.050):
    """Return new triangle vertices, faces and plane indices; coordinates use the baseline frame."""
    centers = np.asarray(camera_centers, dtype=float)
    if centers.ndim != 2 or centers.shape[1] != 3 or not len(centers) or not np.isfinite(centers).all():
        raise ValueError("Expected finite viewer-space camera positions")
    scale = float(np.linalg.norm(np.ptp(centers, axis=0)))
    if not (0 < max_gap_fraction <= .075):
        raise ValueError("Expected a positive maximum gap fraction of at most 0.075.")
    if scale <= np.finfo(float).eps:
        return (np.empty((0, 3)), np.empty((0, 3), np.int32), np.empty(0, np.int32), [],
                {"reason": "The camera centers have no translational baseline.", "camera_path_extent": scale})
    points, _ = _read_ply(points_path)
    if not len(points) or not np.isfinite(points).all():
        raise ValueError("Expected a cleaned, finite point cloud")
    existing = _baseline_triangles(mesh_path)
    step, cell, tol = scale * .004, scale * .005, scale * .003
    measured = points
    points, normals = _plane_samples(measured, step)
    fitted = _fit_planes(points, normals, centers, scale)
    # Fit smaller neighborhoods along the camera path too, so a distinct wall at a
    # corner can win its own consensus even when it occupies little of the full scan.
    for indices in np.array_split(np.arange(len(centers)), min(4, len(centers))):
        local = np.flatnonzero(cKDTree(centers[indices]).query(points)[0] <= .34 * scale)
        for normal, offset, anchors, kind in _fit_planes(points[local], normals[local], centers, scale):
            if not any(k == kind and abs(normal @ n) > .999 and abs(offset - (d if n @ normal > 0 else -d)) < tol
                       for n, d, a, k in fitted):
                fitted.append((normal, offset, local[anchors], kind))
    fitted = [(n, d, points[a], k) for n, d, a, k in fitted]
    ordinary_landmarks = _landmarks(sparse_points, 'sparse', cell)
    sweep = _landmarks(corroborating_points, 'corroborating', cell)
    fitted += _sparse_planes(ordinary_landmarks, centers, scale)
    batches = [(plane, ordinary_landmarks, None) for plane in fitted]
    if len(sweep) >= 3:
        sweep_tree = cKDTree(sweep)
        ordinary = ordinary_landmarks[sweep_tree.query(ordinary_landmarks, workers=4)[0] < .15 * scale]
        combined = _voxel_sample(np.vstack((ordinary, sweep)), cell * .5)
        # Keep the ordinary proposals first for an exact ablation. New samples can
        # corroborate a nearby plane; they cannot alter an existing patch elsewhere.
        for plane in fitted + _sparse_planes(combined, centers, scale):
            normal, offset, anchors, kind = plane
            on_plane = sweep[np.abs(sweep @ normal - offset) < tol]
            if len(on_plane) < 3:
                continue
            local = cKDTree(on_plane)
            within = local.query(anchors, workers=4)[0] < .13 * scale
            if np.count_nonzero(within) >= 6:
                batches.append(((normal, offset, anchors[within], kind), combined, local))
    heights = [np.median(centers @ n - d) for n, d, _, kind in fitted if kind == "floor"]
    # A long recording must not turn a typical doorway-width gap into a short
    # interpolation. Bound the chord by the estimated camera height when available.
    max_edge = scale * max_gap_fraction
    if heights:
        max_edge = min(max_edge, .32 * float(np.median(heights)))
    camera_tree = cKDTree(centers)
    vertices, faces, plane_ids, planes = [], [], [], []
    vertex_count = 0
    for (normal, offset, anchors, kind), landmarks, corroboration in batches:
        signed = np.abs(measured @ normal - offset)
        nearby = measured[signed < tol]
        tree = cKDTree(anchors)
        dist, _ = tree.query(nearby, k=1, workers=4)
        nearby = nearby[dist < scale * .045]
        if len(landmarks):
            sparse = landmarks[np.abs(landmarks @ normal - offset) < tol]
            if len(sparse):
                near_sparse = tree.query(sparse, workers=4)[0] < scale * .12
                sparse = sparse[near_sparse]
                if len(sparse) >= 3:
                    # Isolated landmarks cannot expand the proposed footprint; require
                    # other independently triangulated landmarks in their neighborhood.
                    has_neighbors = cKDTree(sparse).query(sparse, k=[3])[0][:, 0] < scale * .03
                    nearby = np.vstack((nearby, sparse[has_neighbors]))
        # Occupancy votes only need one measured sample per half-cell.
        nearby = np.vstack((nearby, anchors))
        nearby = _voxel_sample(nearby, .5 * cell)
        result = _propose_chart(nearby, normal, offset, existing, cell,
                                max_edge, tol)
        if result is None:
            continue
        xyz, ids = result
        midpoints = xyz[ids].mean(axis=1)
        # A wall proposal cannot occupy the camera trajectory itself. The later
        # visibility pass also checks viewing rays against measured free space.
        keep = camera_tree.query(midpoints, workers=4)[0] > 3 * cell
        if corroboration is not None:
            keep &= corroboration.query(midpoints, workers=4)[0] <= max_edge
        if not keep.any():
            continue
        used, ids = np.unique(ids[keep].ravel(), return_inverse=True)
        xyz, ids = xyz[used], ids.reshape(-1, 3)
        # Later near-parallel hypotheses cannot insert duplicates over this patch.
        existing = np.concatenate((existing, xyz[ids].astype(np.float32)))
        plane_id = len(planes)
        planes.append(dict(id=plane_id, kind=kind, normal=normal.tolist(), offset=offset,
                           spatial_anchors=len(anchors), corroborating_depth=corroboration is not None,
                           proposed_faces=len(ids),
                           proposed_area=len(ids) * cell**2 * .5))
        plane_ids.extend([plane_id] * len(ids))
        vertices.append(xyz)
        faces.append(ids + vertex_count)
        vertex_count += len(xyz)
    summary = dict(plane_trials=len(batches), ordinary_fitted_planes=len(fitted), proposing_planes=len(planes),
                   cell_size=cell, plane_tolerance=tol, max_gap_edge=max_edge,
                   camera_path_extent=scale, normal_supported_samples=len(points), landmark_voxels=len(ordinary_landmarks),
                   corroborating_voxels=len(sweep))
    xyz = np.concatenate(vertices) if vertices else np.empty((0, 3))
    ids = np.concatenate(faces) if faces else np.empty((0, 3), dtype=np.int32)
    return xyz, ids.astype(np.int32), np.array(plane_ids, dtype=np.int32), planes, summary
