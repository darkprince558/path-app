"""Exercise RGB PLY parsing, isolation filtering, viewer coordinates and export budget."""

from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

import numpy as np
from plyfile import PlyData, PlyElement

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cloud_cleanup import clean_cloud


def fixture(path, points):
    # Deliberately interleave optional normals, colors and coordinates. Native
    # OpenMVS and some re-exporters use different layouts and endian markers.
    dtype = [("nx", "f4"), ("blue", "u1"), ("z", "f4"), ("green", "u1"),
             ("x", "f4"), ("red", "u1"), ("y", "f4")]
    data = np.zeros(len(points), dtype=dtype)
    data["x"], data["y"], data["z"] = np.asarray(points).T
    data["red"], data["green"], data["blue"] = 180, 90, 25
    PlyData([PlyElement.describe(data, "vertex")], byte_order=">").write(path)


def rejects(source, out, transform=np.eye(4)):
    try:
        clean_cloud(source, transform, out)
    except ValueError:
        assert not out.exists()
    else:
        raise AssertionError("Invalid cloud passed parsing")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        source, out = folder / "native.ply", folder / "view.ply"
        # Two detached surfaces, one sparse strip, an actual thin wire, four
        # floating dots, and a six-point island. The detached wire stays.
        wall = [(x, y, 0) for x in range(16) for y in range(16)]
        strip = [(120 + x * 3, y * 3, 100) for x in range(8) for y in range(2)]
        wire = [(i, -50, 0) for i in range(20)]
        good = wall + strip + wire
        bad = [(400 + 80 * i, 99, 2) for i in range(4)] + [(30, 0, i) for i in range(6)]
        fixture(source, good + bad + [wall[0], wall[0], (np.nan, 0, 1)])
        transform = np.array([[0, 1, 0, 7], [-1, 0, 0, 2], [0, 0, 1, -3], [0, 0, 0, 1]])
        info = clean_cloud(source, transform, out)
        assert info["input_points"] == len(good) + 13
        assert info["duplicate_points_removed"] == 2 and info["nonfinite_removed"] == 1
        assert info["singleton_points_removed"] == 4 and info["small_component_points_removed"] == 6
        assert info["supported_points"] == info["points"] == len(good)
        assert info["components_kept"] == 3
        vertices = PlyData.read(out)["vertex"].data
        expected = np.asarray(good) @ transform[:3, :3].T + transform[:3, 3]
        actual = np.column_stack([vertices[key] for key in ("x", "y", "z")])
        assert set(map(tuple, actual)) == set(map(tuple, expected))
        assert all((vertices[key] == color).all() for key, color in zip(("red", "green", "blue"), (180, 90, 25)))
        with patch("reconstruct.MAX_RENDER_POINTS", 100):
            limited = clean_cloud(source, transform, folder / "capped.ply")
        assert limited["downsampled_points"] == len(good) - 100 and limited["points"] == 100
        invalid = folder / "invalid.ply"
        invalid.write_bytes(source.read_bytes()[:-9])
        rejects(invalid, folder / "truncated-result.ply")
        fixture(invalid, [(1, 0, 0)] * 5 + [(np.nan, 0, 0)])
        rejects(invalid, folder / "tiny-result.ply")
        rejects(source, folder / "invalid-pose-result.ply", np.full((4, 4), np.nan))
    print("Verified native PLY fields and coordinates, isolated dot and island removal, retained narrow sections and viewer cap.")


if __name__ == "__main__":
    main()
