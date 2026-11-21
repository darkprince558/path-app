"""Exercise multiview anchor agreement, time selection and free-space veto synthetically."""

from pathlib import Path
import struct
import sys
import tempfile

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from plane_depth_anchors import _recover


def write_map(root, index, center_x, depth):
    name = f'frame-{index:06}.jpg'
    resource = ('colmap/images/' + name).encode()
    w, h = 48, 40
    k = np.array([[30, 0, 23.5], [0, 30, 19.5], [0, 0, 1]])
    calibration = np.r_[k.flatten(), np.eye(3).flatten(), center_x, 0, 0].astype('<f8')
    payload = struct.pack('<2sBB4I2fH', b'DR', 1, 0, w, h, w, h, 1, 12, len(resource))
    payload += resource + struct.pack('<III', 2, index, 1) + calibration.tobytes()
    path = root / f'depth{index:04}.dmap'
    path.write_bytes(payload + np.full((h, w), depth, dtype='<f4').tobytes())
    return name


with tempfile.TemporaryDirectory() as temp:
    directory = Path(temp)
    names = {write_map(directory, i, i - 1, 4) for i in range(3)}
    first = {'frame-000000.jpg'}

    def recover(turn, baseline=np.array([[100, 100, 100]])):
        paths = sorted(directory.glob('*.dmap'))
        return _recover(paths, names, turn, baseline, np.eye(4), .04)[0]

    points = recover(first)
    assert len(points) > 0 and np.allclose(points[:, 2], 4)
    assert len(recover(set())) == 0
    assert len(recover(first, baseline=points)) == 0
    for i in range(3):
        write_map(directory, i, 0, 4)
    assert len(recover(first)) == 0  # Coincident cameras cannot corroborate depth.
    for i in range(3):
        write_map(directory, i, i - 1, 4)
    # Two separated cameras looking through the middle of the hypothesized wall.
    names.update(write_map(directory, i, i - 3.5, 8) for i in range(3, 5))
    corrected = recover(first)
    before = (np.linalg.norm(points[:, :2], axis=1) < .6).sum()
    after = (np.linalg.norm(corrected[:, :2], axis=1) < .6).sum()
    assert before > 0 and after == 0
print('Native depth anchor checks passed')
