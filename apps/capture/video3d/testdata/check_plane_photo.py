"""Exercise exact free-space ray checks, translated color witnesses, and embedded atlas UVs."""
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mesh_geometry import _accessor, _read_glb, _source_arrays
from plane_photo import SAMPLES, View, _assign, _free_rays, _view_samples, _write_atlas


def main():
    tri = np.array([[[-.6, -.4, 5], [.6, -.4, 5], [0, .6, 5]]], dtype=float)
    centers = tri.mean(axis=1)
    normals = np.array([[0., 0., 1.]])
    fx = 140.
    with TemporaryDirectory() as directory:
        dest = Path(directory)
        views = []
        colors, scores, anchored = [], [], []
        ys, xs = np.mgrid[:160, :200]
        measured = (SAMPLES @ tri[0]).reshape(-1, 3)
        for index, x in enumerate((-.5, 0., .5)):
            # All photos see the same textured board through translated cameras.
            world_x = (xs + .5 - 100) / fx * 5 + x
            world_y = (ys + .5 - 80) / fx * 5
            image = np.dstack((128 + 36*world_x, 128 + 42*world_y, 140 + 16*world_x)).clip(0, 255).astype(np.uint8)
            path = dest / f"view-{index}.png"
            cv2.imwrite(str(path), image)
            view = View(path.name, path, np.eye(3), np.array([-x, 0., 0.]), np.array([x, 0., 0.]),
                        np.array([fx, fx, 100., 80.]), 200, 160, np.empty((0, 2)), np.empty(0))
            ids, rgb, weight, near, missed, far = _view_samples(view, tri, centers, normals, measured, .01)
            assert ids.tolist() == [0] and not len(missed) and not len(far)
            views.append(view)
            colors.append(rgb)
            scores.append(weight)
            anchored.append(near)
        cameras = np.array([view.center for view in views])
        def assign(cams, rgb=colors, support=anchored, required=None):
            result, _, _ = _assign(np.asarray(rgb), np.asarray(scores), np.asarray(support),
                                   cams, centers, normals, [False], [0], required)
            return result
        assert assign(cameras)[0] >= 0
        assert assign(cameras, required=np.array([False, True, False]))[0] >= 0
        assert assign(cameras, required=np.array([False, False, False]))[0] == -1
        assert assign(np.repeat(cameras[:1], 3, axis=0))[0] == -1
        assert assign(cameras, np.full_like(colors, 140), np.zeros_like(anchored))[0] == -1

        # A single ray to farther geometry lies between the seven RGB probes.
        view = views[1]
        proj, depth = view.project(tri)
        view.observed_xy = (.08*proj[0,0] + .20*proj[0,1] + .72*proj[0,2])[None,:]
        view.observed_z = np.array([6.])
        assert _free_rays(view, proj, depth, .01).tolist() == [True]
        view.observed_z[:] = 5.01
        assert not _free_rays(view, proj, depth, .01).any()
        view.observed_xy[:] = [5, 5]
        view.observed_z[:] = 8.
        assert not _free_rays(view, proj, depth, .01).any()
        _, _, _, _, _, far = _view_samples(view, tri, centers, normals, measured*1.5, .01)
        assert far.tolist() == [0]

        # Sample the actual emitted PNG via GLB UV coordinates, including vertical orientation.
        file = dest / "patch.glb"
        _write_atlas(file, tri, np.array([1]), views)
        doc, raw = _read_glb(file)
        arrays = _source_arrays(doc, raw, dest)
        image = cv2.imdecode(np.frombuffer(arrays[doc['images'][0]['bufferView']], np.uint8), cv2.IMREAD_COLOR)
        prim = doc['meshes'][0]['primitives'][0]
        uv = _accessor(doc, arrays, prim['attributes']['TEXCOORD_0'], 'VEC2', {5126})
        xy = (SAMPLES @ uv) * [image.shape[1], image.shape[0]] - .5
        sampled = cv2.remap(image, xy[None].astype(np.float32), None, cv2.INTER_LINEAR)
        assert np.max(np.abs(colors[1].astype(float)-sampled)) <= 3
    print("Verified ray-through-opening and textureless vetoes, multiview baseline and atlas UV orientation.")


if __name__ == "__main__":
    main()
