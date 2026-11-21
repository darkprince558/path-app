"""Exercise exact sparse ray vetoes including stacked, clipped and hidden additions."""
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from plane_observations import TriangleTree, _blocked_on_rays


def triangle(z, x=0):
    return [[x-1., -1., z], [x+1., -1., z], [x, 1., z]]


def check():
    origin = np.zeros(3)
    rays = np.array([[0., 0., 1.], [2., 0., 1.], [0., 2., 1.]])
    limits = np.full(3, 9.5)
    # The middle-left ray sees existing geometry at z=7, so patches at 4 and 6
    # worsen it but the more distant patch at 8 is invisible behind the baseline.
    base = TriangleTree([triangle(7.)])
    tris = [triangle(z) for z in (4., 6., 8.)] + [triangle(6., 12.), triangle(9.7, 19.4)]
    # Force tree splits and exercise parallel axes along all three center rays.
    tris += [triangle(6., 100+i*3.) for i in range(100)]
    blocked, conflicts, hidden = _blocked_on_rays(base, TriangleTree(tris), origin, rays, limits)
    assert blocked.tolist() == [0, 1, 3] and conflicts == 2 and hidden == 1
    # The near camera plane intersects this triangle, but its positive-depth
    # interior still obstructs the first observed ray.
    ramp = TriangleTree([[[-1., -1., -1.], [1., -1., 4.], [0., 1., 4.]]])
    assert _blocked_on_rays(base, ramp, origin, rays, limits)[0].tolist() == [0]
    # Reversing winding cannot bypass the check on a two-sided display surface.
    back = TriangleTree(np.array([triangle(4.)])[:, ::-1])
    assert _blocked_on_rays(base, back, origin, rays, limits)[0].tolist() == [0]
    assert not _blocked_on_rays(base, back, origin, -rays, limits)[0].size
    print('Verified stacked occlusions, baseline occlusion, depth margin, near-plane crossings, parallel and back-facing rays.')


if __name__ == '__main__':
    check()
