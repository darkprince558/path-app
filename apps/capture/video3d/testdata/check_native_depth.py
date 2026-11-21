"""Synthetic free-space, abstention and raw depth serialization checks."""

from pathlib import Path
import struct
import sys
import tempfile

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from plane_native_depth import depth_veto, read_depth_map


def raw_map(directory, i, cx, depth):
    name = f'colmap/images/view-{i}.jpg'.encode()
    w, h = 48, 40
    k = np.array([[30, 0, 23.5], [0, 30, 19.5], [0, 0, 1]])
    data = struct.pack('<2sBB4I2f', b'DR', 1, 0, w, h, w, h, 1, 10)
    data += struct.pack('<H', len(name)) + name + struct.pack('<III', 2, i, (i + 1) % 3)
    data += np.r_[k.flatten(), np.eye(3).flatten(), cx, 0, 0].astype('<f8').tobytes()
    data += np.broadcast_to(np.float32(depth), (h, w)).astype('<f4').tobytes()
    path = directory / f'depth{i:04d}.dmap'
    path.write_bytes(data)
    return path


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    tri = np.array([[[-.25, -.2, 4], [.25, -.2, 4], [0, .25, 4]]])
    allowed = {f'view-{i}.jpg' for i in range(3)}

    def votes():
        rejected, details = depth_veto(root, tri, np.eye(4), allowed)
        return bool(rejected[0]), int(details['agreements'][:, 0].sum())

    p = raw_map(root, 0, -.5, 6)
    assert read_depth_map(p)[4].shape == (40, 48)
    raw_map(root, 1, -.49, 6)
    assert votes() == (False, 0)  # Insufficient ray angle.
    raw_map(root, 1, .5, 6)
    assert votes() == (True, 0)
    raw_map(root, 2, 0, 4)
    assert votes() == (True, 1)  # Two separated free-space views veto even when a third supports it.
    for i in range(3):
        raw_map(root, i, .5 * (i - 1), 0)
    assert votes() == (False, 0)  # Missing measurements abstain.
    raw_map(root, 1, .5, 3)
    assert votes() == (False, 0)  # Foreground occlusion is not a free-space vote.
    payload = p.read_bytes()
    for damaged in [b'DR', payload[:-4], b'XX' + payload[2:], payload + b'z']:
        p.write_bytes(damaged)
        try:
            read_depth_map(p)
        except ValueError:
            pass
        else:
            raise AssertionError('Malformed map unexpectedly accepted')
print('Native OpenMVS depth checks passed')
