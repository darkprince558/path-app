"""Remove isolated samples from an OpenMVS RGB cloud before viewer downsampling."""

from pathlib import Path

import numpy as np
from plyfile import PlyData, PlyParseError
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from reconstruct import write_cloud


def _read_vertices(path):
    # OpenMVS adds normals to some releases' scalar PLY schema. Use property
    # names, not offsets, and let plyfile handle byte order and truncation.
    try:
        data = PlyData.read(path, mmap="r")
        vertices = data["vertex"].data
    except (KeyError, ValueError, PlyParseError) as exc:
        raise ValueError(f"Invalid OpenMVS vertex PLY: {exc}") from exc
    fields = vertices.dtype.fields or {}
    for name in ("x", "y", "z"):
        if name not in fields or fields[name][0].kind not in "fiu":
            raise ValueError(f"Expected a scalar numeric {name} coordinate in {path}")
    for name in ("red", "green", "blue"):
        if name not in fields or fields[name][0] != np.dtype("u1"):
            raise ValueError(f"Expected RGB byte property {name} in {path}")
    return vertices


def _supported_points(xyz):
    """Connect bounded local neighbors, then retain every substantial component."""
    count = len(xyz)
    if count < 3:
        raise ValueError("Need at least three distinct finite cloud points to assess local support.")
    tree = cKDTree(xyz)
    neighbors = min(8, count)
    # A bounded-degree graph avoids quadratic memory on dense surfaces.
    # Query in chunks and store only compact distances and neighbor IDs.
    indices = np.empty((count, neighbors), dtype=np.int32)
    distance = np.empty((count, neighbors), dtype=np.float32)
    chunk = 32_768
    for start in range(0, count, chunk):
        end = min(start + chunk, count)
        distance[start:end], indices[start:end] = tree.query(xyz[start:end], k=neighbors, workers=4)
    del tree
    # All radii use measured spacing in the reconstruction's arbitrary units.
    # Sample density falls with distance from the phone. Allow more reach on
    # sparse surfaces but cap it so isolated samples cannot bridge empty space.
    nearest = distance[:, 1]
    median, upper = np.percentile(nearest, [50, 90]).astype(float)
    minimum_radius, maximum_radius = 4 * median, 4 * upper
    radius = np.empty(count, dtype=np.float32)
    for start in range(0, count, chunk):
        end = min(start + chunk, count)
        local_spacing = np.median(nearest[indices[start:end, 1:]], axis=1)
        radius[start:end] = np.clip(6 * local_spacing, minimum_radius, maximum_radius)
    for start in range(0, count, chunk):
        end = min(start + chunk, count)
        adjacent = indices[start:end]
        # Both endpoints must support the gap. A stray point near a dense
        # wall cannot attach itself solely on the strength of its own radius.
        supported = distance[start:end] <= np.minimum(radius[start:end, None], radius[adjacent])
        indices[start:end] = np.where(supported, adjacent, np.arange(start, end)[:, None])
    del distance, nearest
    indptr = np.arange(0, indices.size + 1, neighbors, dtype=np.int64)
    graph = csr_matrix((np.ones(indices.size, dtype=bool), indices.ravel(), indptr), shape=(count, count))
    component_count, components = connected_components(graph, directed=False)
    sizes = np.bincount(components, minlength=component_count)
    min_size = min(12, max(3, count // 3))
    keep = sizes[components] >= min_size
    if not keep.any():
        raise ValueError("No locally supported point component survived isolation filtering.")
    return keep, {
        "median_neighbor_distance": float(median), "neighbor_distance_p90": float(upper),
        "connection_radius_min": float(minimum_radius), "connection_radius_max": float(maximum_radius),
        "neighbor_limit_including_self": neighbors, "min_component_points": min_size,
        "components_before": int(component_count),
        "components_kept": int(np.count_nonzero(sizes >= min_size)),
        "singleton_points_removed": int(np.count_nonzero(sizes == 1)),
        "small_component_points_removed": int(sizes[(sizes > 1) & (sizes < min_size)].sum()),
    }


def clean_cloud(source, world_to_view, output_path):
    """Write the supported RGB cloud in viewer coordinates and return count accounting."""
    source, output_path = Path(source), Path(output_path)
    if source.resolve() == output_path.resolve():
        raise ValueError("Choose a separate output PLY to preserve the original cloud.")
    transform = np.asarray(world_to_view, dtype=np.float64)
    if (transform.shape != (4, 4) or not np.isfinite(transform).all()
            or not np.allclose(transform[3], [0, 0, 0, 1])
            or not np.allclose(transform[:3, :3].T @ transform[:3, :3], np.eye(3), atol=1e-5)):
        raise ValueError("Expected a finite rigid 4x4 world-to-view transform.")
    vertices = _read_vertices(source)
    source_count = len(vertices)
    raw = np.column_stack([vertices[key] for key in ("x", "y", "z")])
    with np.errstate(over="ignore", invalid="ignore"):
        xyz = (raw @ transform[:3, :3].T + transform[:3, 3]).astype(np.float32)
    rgb = np.column_stack([vertices[key] for key in ("red", "green", "blue")])
    finite = np.isfinite(xyz).all(axis=1)
    xyz, rgb = xyz[finite], rgb[finite]
    finite_count = len(xyz)
    # Repeated vertices cannot supply independent neighborhood evidence.
    _, first = np.unique(xyz, axis=0, return_index=True)
    xyz, rgb = xyz[first], rgb[first]
    keep, support = _supported_points(xyz)
    retained = int(keep.sum())
    # Each kept island is supported in 3D. A second axis-percentile crop could
    # delete a legitimate detached section merely because it is far away.
    export = write_cloud(output_path, xyz[keep], rgb[keep], crop_bounds=False)
    return {
        "input_points": source_count, "nonfinite_removed": source_count - finite_count,
        "duplicate_points_removed": finite_count - len(xyz), "isolated_points_removed": len(xyz) - retained,
        "supported_points": retained, "downsampled_points": retained - export["points"],
        "points": export["points"], "bytes": export["bytes"], **support,
    }
