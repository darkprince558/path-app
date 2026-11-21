"""Check planar gap triangles against multiple calibrated photographs and bake their texture."""

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pycolmap
from scipy.spatial import cKDTree

from mesh import saved_scene
from mesh_geometry import _append_accessor, _append_view, _pack_glb, _read_ply
from plane_views import ordered_poses, reserved_photo, training_photo


# Internal barycentric samples probe both the center and all three sides.
SAMPLES = np.array([[1/3, 1/3, 1/3], [.7, .15, .15], [.15, .7, .15], [.15, .15, .7],
                    [.45, .45, .1], [.45, .1, .45], [.1, .45, .45]], np.float32)


@dataclass
class View:
    name: str
    path: Path
    rotation: np.ndarray
    translation: np.ndarray
    center: np.ndarray
    intrinsic: np.ndarray
    width: int
    height: int
    observed_xy: np.ndarray
    observed_z: np.ndarray

    def project(self, world):
        cam = world @ self.rotation.T + self.translation
        z = cam[..., 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            xy = cam[..., :2] / z[..., None] * self.intrinsic[:2] + self.intrinsic[2:]
        return xy, z


def _views(run, source, transform):
    folder = run / "openmvs/colmap"
    model = pycolmap.Reconstruction(folder / "sparse")
    locations = {key: point.xyz for key, point in model.points3D.items()
                 if point.track.length() >= 4 and point.error < 1.5}
    sequence = ordered_poses(model)
    heldout = [im.name for i, im in enumerate(sequence) if reserved_photo(i)]
    views = []
    image_root = (folder / "images").resolve()
    weak = set(source.get("reconstruction", {}).get("weak_frame_names", []))
    for index, image in enumerate(sequence):
        if not training_photo(index, image.num_points3D, image.name in weak):
            continue
        camera = model.cameras[image.camera_id]
        if camera.model_name != "PINHOLE":
            raise ValueError("Planar photo checks require the saved undistorted pinhole cameras.")
        path = (image_root / image.name).resolve()
        if not path.is_relative_to(image_root) or not path.is_file():
            raise ValueError("Missing calibrated photo inside the saved camera image directory.")
        # Transform from viewer coordinates directly to the saved photograph's camera.
        pose = image.cam_from_world()
        rotation = pose.rotation.matrix() @ transform[:3, :3].T
        translation = pose.translation - rotation @ transform[:3, 3]
        measured = [p for p in image.get_observation_points2D() if p.point3D_id in locations]
        native = np.array([locations[p.point3D_id] for p in measured], dtype=np.float64).reshape(-1, 3)
        observed_xy = np.array([p.xy for p in measured], dtype=np.float64).reshape(-1, 2)
        observed_z = native @ pose.rotation.matrix()[2] + pose.translation[2]
        views.append(View(image.name, path, rotation, translation, -rotation.T @ translation,
                          np.asarray(camera.params), camera.width, camera.height, observed_xy, observed_z))
    return views, heldout


def _depth_map(view, xyz):
    # Minimum depth within a two-pixel cell, kept empty between observations.
    step = 2
    w, h = (view.width + 1) // step, (view.height + 1) // step
    xy, z = view.project(xyz)
    inside = (z > 0) & (xy >= 0).all(axis=1) & (xy < [view.width, view.height]).all(axis=1)
    grid = (xy[inside] / step).astype(np.int32)
    result = np.full(h * w, np.inf, np.float32)
    np.minimum.at(result, grid[:, 1] * w + grid[:, 0], z[inside])
    return result.reshape(h, w)


def _read_image(view):
    image = cv2.imread(str(view.path), cv2.IMREAD_COLOR)
    if image is None or image.shape[:2] != (view.height, view.width):
        raise ValueError(f"Unreadable or incorrectly sized calibrated photo: {view.name}")
    return image


def _free_rays(view, triangles, depths, tolerance):
    """Intersect measured 2D feature rays with the exact projected triangle footprint."""
    blocked = np.zeros(len(triangles), bool)
    if not len(view.observed_z) or not len(triangles):
        return blocked
    centers = triangles.mean(axis=1)
    radius = np.linalg.norm(triangles - centers[:, None], axis=2).max(axis=1)
    nearby = cKDTree(view.observed_xy).query_ball_point(centers, radius)
    lengths = np.fromiter(map(len, nearby), dtype=np.int64, count=len(nearby))
    if not lengths.any():
        return blocked
    ids = np.repeat(np.arange(len(triangles)), lengths)
    obs = np.concatenate(nearby[lengths > 0]).astype(np.intp)
    tri = triangles[ids]
    a, b = tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]
    v = view.observed_xy[obs] - tri[:, 0]
    determinant = a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]
    u = (v[:, 0] * b[:, 1] - v[:, 1] * b[:, 0]) / determinant
    w = (a[:, 0] * v[:, 1] - a[:, 1] * v[:, 0]) / determinant
    bary = np.column_stack((1-u-w, u, w))
    inside = (bary >= 0).all(axis=1)
    hit = 1 / np.sum(bary[inside] / depths[ids[inside]], axis=1)
    behind = view.observed_z[obs[inside]] > hit + np.maximum(tolerance, hit * .05)
    blocked[ids[inside][behind]] = True
    return blocked


def _view_samples(view, tris, centers, normals, points, tolerance):
    xy, depths = view.project(tris)
    rays = view.center - centers
    rays /= np.maximum(np.linalg.norm(rays, axis=1, keepdims=True), 1e-12)
    incidence = np.einsum("fi,fi->f", rays, normals)
    a, b = xy[:, 1] - xy[:, 0], xy[:, 2] - xy[:, 0]
    areas = .5 * np.abs(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0])
    intersects = ((depths > 0).all(axis=1) & (xy.max(axis=1) >= 0).all(axis=1)
                  & (xy.min(axis=1) < [view.width, view.height]).all(axis=1) & (areas > .01))
    tested = np.flatnonzero(intersects)
    free_ids = tested[_free_rays(view, xy[tested], depths[tested], tolerance)]
    visible = ((depths > 0).all(axis=1) & (xy >= 2).all(axis=(1, 2))
               & (xy < [view.width - 2, view.height - 2]).all(axis=(1, 2))
               & (np.abs(incidence) > .20) & (areas >= 1.5))
    ids = np.flatnonzero(visible)
    if not len(ids):
        return ids, [], [], [], free_ids, ids
    samples = np.einsum("kj,fji->fki", SAMPLES, tris[ids])
    pix, z = view.project(samples)
    fine = (pix / 2).astype(np.int32)
    xx, yy = fine[..., 0], fine[..., 1]
    dense = _depth_map(view, points)[yy, xx]
    # A known, actually observed feature behind the proposed plane is a free-space ray.
    # A farther dense sample alone is ambiguous because its original camera may differ.
    margin = np.maximum(tolerance, z * .045)
    free = np.isin(ids, free_ids)
    anchored = (np.abs(dense - z) <= margin).sum(axis=1) >= 2
    far = (np.isfinite(dense) & (dense > z + 1.5 * margin)).sum(axis=1) >= 3
    occluded = (dense < z - margin).sum(axis=1) >= 2
    valid = ~(free | far | occluded)
    image = _read_image(view)
    # COLMAP pixel centers start at (0.5, 0.5), OpenCV at (0, 0).
    color = np.empty((int(valid.sum()), len(SAMPLES), 3), np.uint8)
    coords = (pix[valid] - .5).astype(np.float32)
    for start in range(0, len(coords), 10_000):
        color[start:start + 10_000] = cv2.remap(image, coords[start:start + 10_000], None, cv2.INTER_LINEAR)
    return ids[valid], color, np.sqrt(areas[ids[valid]]) * np.abs(incidence[ids[valid]]), anchored[valid], free_ids, ids[far]


def _assign(colors, scores, anchored, cameras, centers, normals, free, far, required_view=None):
    selected = np.full(len(centers), -1, np.int32)
    agreements = np.zeros(len(centers), np.int32)
    photo_errors = np.zeros(len(centers))
    for idx, center in enumerate(centers):
        if free[idx] or far[idx] >= 2:
            continue
        views = np.flatnonzero(scores[:, idx] > 0)
        if len(views) < 3:
            continue
        # Require agreement in three views and appreciable translation between two
        # witnesses and the texture source. Adjacent nearly-identical frames cannot vote.
        directions = cameras[views] - center
        directions /= np.linalg.norm(directions, axis=1, keepdims=True)
        cosine = directions @ directions.T
        independent = (cosine <= np.cos(np.deg2rad(2.5))) & (cosine >= np.cos(np.deg2rad(45)))
        sidedness = np.sign(directions @ normals[idx])
        independent &= sidedness[:, None] == sidedness[None, :]
        # Test the best projected reference candidates first. All visible views can witness.
        for row in np.argsort(scores[views, idx])[::-1][:12]:
            delta = np.abs(colors[views, idx].astype(np.int16) - colors[views[row], idx])
            residual = delta.mean(axis=(1, 2))
            compatible = independent[row] & (residual <= 13) & (delta.mean(axis=2).max(axis=1) <= 30)
            witnesses = np.flatnonzero(compatible)
            if len(witnesses) < 2 or not independent[np.ix_(witnesses, witnesses)].any():
                continue
            agreeing_views = views[np.r_[row, witnesses]]
            if required_view is not None and not required_view[agreeing_views].any():
                continue
            # Uniform colors alone also agree at the wrong depth. On a flat image
            # patch require measured geometry near the proposed depth in two of
            # the actual agreeing photos.
            contrast = np.ptp(colors[views[row], idx].astype(float), axis=0).mean()
            if contrast < 7 and anchored[agreeing_views, idx].sum() < 2:
                continue
            selected[idx] = views[row]
            agreements[idx] = len(witnesses)
            photo_errors[idx] = np.median(residual[witnesses])
            break
    return selected, agreements, photo_errors


def _write_atlas(path, tri, assignments, views):
    # Build small, masked projective charts. Adjacent padding repeats the nearest
    # triangle edge. Unused portions of private source photographs never enter the GLB.
    tiles = []
    for i in np.unique(assignments):
        indices = np.flatnonzero(assignments == i)
        xy, _ = views[i].project(tri[indices])
        lengths = np.linalg.norm(xy - np.roll(xy, 1, axis=1), axis=2).max(axis=1)
        for idx, length in zip(indices, lengths):
            tiles.append((int(idx), int(np.clip(np.ceil(length), 6, 128)) + 4))
    tiles.sort(key=lambda item: (-item[1], item[0]))
    atlas_width = min(2048, max(max(t for _, t in tiles), int(np.ceil(np.sqrt(sum(t*t for _, t in tiles))))))
    chart = np.zeros((len(tri), 4), np.int32)
    page = x = y = row = 0
    heights = []
    for idx, t in tiles:
        if x + t > atlas_width:
            x, y, row = 0, y + row, 0
        if y + t > 2048:
            heights.append(y + row)
            page, x, y, row = page + 1, 0, 0, 0
        chart[idx] = page, x, y, t
        x, row = x + t, max(row, t)
    heights.append(y + row)
    atlases = [np.zeros((h, atlas_width, 3), np.uint8) for h in heights]
    uv = np.empty((len(tri), 3, 2), np.float32)
    for i in np.unique(assignments):
        view = views[i]
        image = _read_image(view)
        for idx in np.flatnonzero(assignments == i):
            pg, x, y, t = chart[idx]
            raw = (np.arange(t) - 2) / (t - 5)
            u, v = np.meshgrid(raw.clip(0, 1), raw.clip(0, 1))
            denominator = np.maximum(1., u + v)
            u, v = u / denominator, v / denominator
            tr = tri[idx]
            world = tr[0] + u[..., None] * (tr[1] - tr[0]) + v[..., None] * (tr[2] - tr[0])
            coords, _ = view.project(world)
            atlases[pg][y:y+t, x:x+t] = cv2.remap(image, (coords-.5).astype(np.float32), None, cv2.INTER_LINEAR)
            uv[idx] = np.array([[x+2.5,y+2.5], [x+t-2.5,y+2.5], [x+2.5,y+t-2.5]]) / [atlas_width, heights[pg]]
    mesh = {"name":"Plane fills","primitives":[]}
    out = {"asset":{"version":"2.0"},"scene":0,"nodes":[{"mesh":0,"name":"Plane fills"}],
           "scenes":[{"nodes":[0]}],"meshes":[mesh],"extensionsUsed":["KHR_materials_unlit"],
           "materials":[],"textures":[],"images":[],"accessors":[],"bufferViews":[],
           "samplers":[{"magFilter":9729,"minFilter":9729,"wrapS":33071,"wrapT":33071}]}
    buf = bytearray()
    for pg, atlas in enumerate(atlases):
        ok, encoded = cv2.imencode(".png", atlas)
        if not ok:
            raise RuntimeError("Could not encode plane patch texture.")
        out["images"].append({"mimeType":"image/png","bufferView":_append_view(out, buf, encoded.tobytes())})
        out["textures"].append({"source":pg,"sampler":0})
        out["materials"].append({"name":"Plane fills", "doubleSided":True,"extensions":{"KHR_materials_unlit":{}},
            "pbrMetallicRoughness":{"baseColorTexture":{"index":pg},"metallicFactor":0,"roughnessFactor":1}})
        subset = chart[:,0] == pg
        xyz = tri[subset].reshape(-1,3).astype("<f4")
        attributes = {"POSITION":_append_accessor(out, buf, xyz,"VEC3"),
                      "TEXCOORD_0":_append_accessor(out,buf,uv[subset].reshape(-1,2).astype("<f4"),"VEC2")}
        mesh["primitives"].append({"mode":4, "material":pg, "attributes":attributes,
                                   "indices":_append_accessor(out,buf,np.arange(len(xyz),dtype="<u4"),"SCALAR")})
    _pack_glb(out, buf, path)


def verify_and_texture(run, vertices, faces, plane_ids, output_glb, *, turn=None):
    """Return proposal indices with depth and independent photographic support."""
    run = Path(run)
    faces, vertices, plane_ids = np.asarray(faces), np.asarray(vertices), np.asarray(plane_ids)
    if (vertices.ndim != 2 or vertices.shape[1] != 3 or not np.isfinite(vertices).all()
            or faces.ndim != 2 or faces.shape[1] != 3 or faces.dtype.kind not in "iu"
            or len(faces) != len(plane_ids) or (len(faces) and (faces.min() < 0 or faces.max() >= len(vertices)))):
        raise ValueError("Invalid proposed plane triangles.")
    stats = {"proposals":len(faces), "accepted_faces":0, "texture_sources":{}, "texture_source_count":0, "heldout_rule":"sorted_index % 5 == 2"}
    if Path(output_glb).exists():
        raise FileExistsError(f"Choose a new patch output file: {output_glb}")
    if not len(faces):
        return np.empty(0, np.int64), stats
    source, transform = saved_scene(run)
    views, heldout = _views(run, source, transform)
    stats.update(heldout_views=len(heldout), heldout_frame_names=heldout, checked_views=len(views))
    if len(views) < 3:
        return np.empty(0, np.int64), stats
    required_view = None
    if turn is not None:
        fps = source["video"]["sample_fps"]
        times = np.array([(int(Path(view.name).stem.split("-")[-1]) - 1) / fps for view in views])
        required_view = (times >= turn[0]) & (times <= turn[1])
        stats["turn_witness_cameras"] = int(required_view.sum())
        if not required_view.any():
            return np.empty(0, np.int64), stats
    points, _ = _read_ply(run / "mesh/points.ply")
    tris = vertices[faces].astype(np.float32)
    center = tris.mean(axis=1)
    normal = np.cross(tris[:,1] - tris[:,0], tris[:,2] - tris[:,0])
    normal /= np.maximum(np.linalg.norm(normal,axis=1,keepdims=True), 1e-12)
    # Relative scale comes from the existing capture, so the test works for monocular reconstruction units.
    cameras = np.array([v.center for v in views])
    tolerance = max(1e-6, .003 * np.linalg.norm(np.ptp(cameras,axis=0)))
    total = len(faces)
    selected = np.full(total, -1, np.int32)
    agreements = np.zeros(total, np.int32)
    photo_errors = np.zeros(total)
    free_count = far_count = 0
    # Cap per-batch photo sample storage at roughly 24 MB for long captures.
    batch = max(1, min(total, 24_000_000 // (len(views) * (len(SAMPLES) * 3 + 4))))
    for lo in range(0, total, batch):
        hi = min(lo + batch, total)
        n = hi-lo
        colors = np.zeros((len(views),n,len(SAMPLES),3), np.uint8)
        scores = np.zeros((len(views),n), np.float32)
        anchored = np.zeros((len(views), n), bool)
        free = np.zeros(n,bool)
        far = np.zeros(n,np.int32)
        for i, view in enumerate(views):
            ids, rgb, weights, near, misses, distant = _view_samples(view, tris[lo:hi], center[lo:hi], normal[lo:hi], points, tolerance)
            if len(ids):
                scores[i,ids], colors[i,ids], anchored[i,ids] = weights, rgb, near
            free[misses] = True
            far[distant] += 1
        selected[lo:hi], agreements[lo:hi], photo_errors[lo:hi] = _assign(
            colors, scores, anchored, cameras, center[lo:hi], normal[lo:hi], free, far, required_view)
        free_count += np.count_nonzero(free)
        far_count += np.count_nonzero(~free & (far >= 2))
    accepted = np.flatnonzero(selected >= 0)
    names = {views[i].name:int(np.count_nonzero(selected == i)) for i in np.unique(selected[accepted])}
    stats.update(accepted_faces=len(accepted), observed_free_space_rejections=int(free_count),
                 multiple_farther_depth_rejections=int(far_count),
                 insufficient_independent_photos=total-len(accepted)-int(free_count)-int(far_count),
                 texture_sources=names, texture_source_count=len(names))
    if len(accepted):
        stats.update(median_witness_count=float(np.median(agreements[accepted])),
                     median_crossview_srgb_error=float(np.median(photo_errors[accepted])))
        _write_atlas(output_glb, tris[accepted], selected[accepted], views)
    return accepted, stats
