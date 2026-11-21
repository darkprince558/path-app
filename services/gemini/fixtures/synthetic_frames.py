"""Deterministic synthetic corridor images, generated in memory.

No photo or binary image is committed. These flat-shaded drawings stand in for
Anish's RGB frames so tests and the opt-in live test never touch private venue
imagery. Only the Python standard library is used.

Scenes:
- ``landmark``: a corridor with a large purple panel on the left wall next to a
  left-hand opening, seen from approach, junction, and exit positions.
- ``blank``: the same corridor geometry with plain grey walls and no
  distinctive feature (a case where abstention is the expected good answer).
"""

import struct
import zlib
from typing import Callable, Dict, List, Tuple

Color = Tuple[int, int, int]

WIDTH = 320
HEIGHT = 240

WALL = (176, 176, 170)
WALL_DARK = (140, 140, 134)
FLOOR = (110, 100, 90)
CEILING = (220, 220, 215)
END_WALL = (196, 196, 190)
OPENING = (45, 45, 50)
PURPLE = (120, 40, 160)
PURPLE_LIGHT = (170, 90, 210)
DOOR = (120, 80, 40)


def png_bytes(width: int, height: int, pixel: Callable[[int, int], Color]) -> bytes:
    """Encode an RGB image as PNG using zlib only."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter type: none
        for x in range(width):
            rows.extend(pixel(x, y))
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


def _corridor(depth: float, mural: bool, opening: bool) -> Callable[[int, int], Color]:
    """One-point-perspective corridor. ``depth`` 0..1 moves the walker forward."""
    cx, cy = WIDTH / 2, HEIGHT / 2
    # End wall rectangle grows as the walker approaches.
    half_w = 40 + 70 * depth
    half_h = 30 + 50 * depth
    left, right = cx - half_w, cx + half_w
    top, bottom = cy - half_h, cy + half_h

    def pixel(x: int, y: int) -> Color:
        if left <= x <= right and top <= y <= bottom:
            return END_WALL
        # Which surface: use the diagonal from each corner to the image corner.
        if x < left:
            t = (left - x) / left  # 0 at end wall, 1 at image edge
            wall_top = top - t * top
            wall_bottom = bottom + t * (HEIGHT - bottom)
            if y < wall_top:
                return CEILING
            if y > wall_bottom:
                return FLOOR
            # Left wall features: mural first (closer), opening further in.
            if opening and 0.05 < t < 0.28:
                return OPENING
            if mural and 0.32 < t < 0.75:
                span = wall_bottom - wall_top
                if wall_top + 0.2 * span < y < wall_top + 0.8 * span:
                    return PURPLE_LIGHT if int((t * 40)) % 4 == 0 else PURPLE
            return WALL
        if x > right:
            t = (x - right) / (WIDTH - right)
            wall_top = top - t * top
            wall_bottom = bottom + t * (HEIGHT - bottom)
            if y < wall_top:
                return CEILING
            if y > wall_bottom:
                return FLOOR
            return WALL_DARK
        return CEILING if y < top else FLOOR

    return pixel


def _exit_view(mural: bool) -> Callable[[int, int], Color]:
    """After turning left: a short corridor ending in a brown door."""
    base = _corridor(0.6, mural=False, opening=False)
    cx = WIDTH / 2

    def pixel(x: int, y: int) -> Color:
        if cx - 22 <= x <= cx + 22 and 85 <= y <= 168:
            return DOOR
        if mural and x > WIDTH - 40 and 70 < y < 170:
            return PURPLE  # edge of the panel just passed, now on the right
        return base(x, y)

    return pixel


def scene_frames(scene: str) -> Dict[str, bytes]:
    """Return ``{role: png_bytes}`` for ``landmark`` or ``blank``."""
    mural = scene == "landmark"
    if scene not in ("landmark", "blank"):
        raise ValueError("unknown scene")
    return {
        "approach": png_bytes(WIDTH, HEIGHT, _corridor(0.0, mural=mural, opening=True)),
        "junction": png_bytes(WIDTH, HEIGHT, _corridor(0.55, mural=mural, opening=True)),
        "exit": png_bytes(WIDTH, HEIGHT, _exit_view(mural)),
    }


def tiny_png() -> bytes:
    """A 4x4 grey PNG for unit tests."""
    return png_bytes(4, 4, lambda x, y: (128, 128, 128))


def tiny_jpeg_like() -> bytes:
    """Bytes with a JPEG signature. Enough for local validation, never sent."""
    return b"\xff\xd8\xff\xe0" + b"\x00" * 32 + b"\xff\xd9"


def roles() -> List[str]:
    return ["approach", "junction", "exit"]


if __name__ == "__main__":  # Write previews to a directory you choose (not committed).
    import sys
    from pathlib import Path

    out = Path(sys.argv[1] if len(sys.argv) > 1 else "synthetic-preview")
    out.mkdir(parents=True, exist_ok=True)
    for scene in ("landmark", "blank"):
        for role, data in scene_frames(scene).items():
            (out / "{}-{}.png".format(scene, role)).write_bytes(data)
    print("wrote previews to", out)
