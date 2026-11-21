"""Check bilateral image matching, holdout exclusion and original-mesh depth rejection."""

from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from plane_sweep_depth import (Camera, _groups, _mesh_depth, _rasterizer, _repeated,
                               _sweep_reference, sweep_anchors)


def main():
    empty, stats = sweep_anchors(None, None, None)
    assert empty.shape == (0, 3) and stats["status"] == "skipped"

    # Translating by 0.125 moves a fronto-parallel plane at Z=3 exactly two pixels.
    w, h = 80, 60
    cams = [Camera(Path(f"frame-{i+1:06d}.jpg"), (h, w), (w, h), np.array([48., 48., 40., 30.]),
                   np.eye(3), np.array([i * 0.125, 0, 0]), 50, i/8) for i in range(12)]
    texture = np.random.default_rng(17).integers(0, 256, size=(h, w+24)).astype(np.float32)
    ref = 5
    groups = _groups(cams, ref)

    def image(i):
        assert i % 5 != 2
        return texture[:, i*2:i*2+w]

    depths = np.geomspace(1.5, 6, 21)
    background = np.full((h, w), np.inf, dtype=np.float32)
    original = background.copy()
    original[:, :w//2] = 3.0

    def run(gray=image, other_depth=background):
        return _sweep_reference(ref, cams, groups, gray, lambda i: original if i == ref else other_depth,
                                depths, 3.0)

    anchors, counts = run()
    assert counts["matched_pixels"] > 1000 and len(anchors) > 500
    relative_error = np.abs(anchors[:, 2] / 3 - 1)
    assert np.max(relative_error) < 0.04 and (relative_error < 0.001).mean() > 0.95
    assert (anchors[:, 0] > cams[ref].center[0]).all(), "Only original mesh holes qualify"
    assert not len(run(lambda i: np.ones((h, w), np.float32))[0])
    conflict = np.full((h, w), 6, dtype=np.float32)
    assert not len(run(other_depth=conflict)[0]), "A verified free ray vetoes the candidate"
    for camera in cams:
        camera.center[:] = 0
    assert not len(run()[0]), "Rotation alone cannot yield depth"

    points = {4: np.array([[0., 0, 0]]), 5: np.array([[0.01, 0, 0]])}
    assert not any(map(len, _repeated(points, 0.1).values()))
    points[7] = np.array([[0.03, 0, 0], [6, 1, 0]])
    assert [len(x) for x in _repeated(points, 0.1).values()] == [1, 1, 1]

    vertices = np.array([[-1, -1, 2.], [1, -1, 2.], [0, 1, 2.]])
    face = np.array([[0, 1, 2]], np.int32)
    with TemporaryDirectory() as temp:
        fn = _rasterizer(temp, shutil.which("cc"))
        depth = _mesh_depth(fn, [(vertices, face, True), (vertices*2, face, True)], cams[0], 0.01)
        assert depth[30, 40] == 2 and np.isinf(depth[0, 0])
        clipped = vertices.copy()
        clipped[0, 2] = -1
        depth = _mesh_depth(fn, [(clipped, face, True)], cams[0], 0.01)
        assert np.any(np.isfinite(depth)) and np.all(depth >= 0.01)
    print("Plane sweep matched known depth, rejected prior-mesh/weak geometry and excluded holdout RGB.")


if __name__ == "__main__":
    main()
