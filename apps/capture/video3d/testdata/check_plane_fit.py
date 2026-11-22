"""Exercise local plane interpolation, existing surfaces, and a supported doorway opening."""

from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from plane_fit import _fit_planes, _plane_samples, _propose_chart, _sparse_planes, propose


def main():
    assert len(propose(None, None, np.zeros((4, 3)))[1]) == 0
    # The wall covers x=[-3,3], y=[-1,2], with a large doorway open to the edge.
    xs, ys = np.meshgrid(np.arange(-3, 3.001, .045), np.arange(-1, 2.001, .045))
    door = (abs(xs) < .56) & (ys < 1.1)
    small_hole = ((xs - 1.45) ** 2 + (ys - .5) ** 2) < .09 ** 2
    keep = ~(door | small_hole)
    anchors = np.column_stack((xs[keep], ys[keep], np.zeros(keep.sum())))
    existing = np.array([[[-3., -1., 0.], [-1., -1., 0.], [-1., 2., 0.]],
                         [[-3., -1., 0.], [-1., 2., 0.], [-3., 2., 0.]]])
    vertices, faces = _propose_chart(anchors, np.array([0., 0., 1.]), 0., existing, .035, .33, .012)
    centers = vertices[faces].mean(axis=1)
    assert abs(vertices[:, 2]).max() < 1e-8
    assert np.any(np.linalg.norm(centers[:, :2] - [1.45, .5], axis=1) < .045), "missed enclosed pinhole"
    assert not np.any((abs(centers[:, 0]) < .53) & (centers[:, 1] < .93)), "filled open doorway"
    assert np.all(centers[:, 0] > -1.), "overwrote an existing triangle"
    # Two disjoint islands closer than the max chord must still have measured
    # connectivity in the chart before any face can bridge them.
    separated = anchors[(anchors[:, 0] < 1) | (anchors[:, 0] > 1.25)]
    vv, ff = _propose_chart(separated, np.array([0., 0., 1.]), 0., existing, .035, .45, .012)
    cc = vv[ff].mean(axis=1)
    assert not np.any((cc[:, 0] > 1.03) & (cc[:, 0] < 1.22))

    # Add a floor and a ceiling. Above-camera parallel surfaces cannot become floors.
    floor = np.column_stack((anchors[:, 0], np.full(len(anchors), -1.4), anchors[:, 1]))
    ceiling = floor + [0., 3., 0.]
    points = np.vstack((anchors, floor, ceiling))
    path = np.column_stack((np.linspace(-1.8, 1.8, 30), np.zeros(30), np.full(30, 1.)))
    sample, normals = _plane_samples(points, .04)
    for planes in (_fit_planes(sample, normals, path, 4), _sparse_planes(points[::3], path, 4)):
        assert any(kind == "wall" for _, _, _, kind in planes)
        assert any(kind == "floor" for _, _, _, kind in planes)
        assert all(offset < 0 for _, offset, _, kind in planes if kind == "floor")
    print("Verified measured floor/wall fits, local pinhole interpolation, open doorway, disconnected panels, and baseline exclusion.")


if __name__ == "__main__":
    main()
