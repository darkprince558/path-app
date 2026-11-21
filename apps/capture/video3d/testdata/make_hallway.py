"""Generate an 18-second synthetic camera walk for the video reconstruction smoke test."""

import argparse
import math
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

import cv2
import numpy as np


WIDTH, HEIGHT = 800, 450
FPS, SECONDS = 12, 18
HALL_WIDTH, HALL_HEIGHT, HALL_LENGTH = 3.6, 2.8, 10.0
PIXELS_PER_METER = 220


def surface(width, height, color, rng):
    """Make stable multiscale material texture. Inputs are in scene meters."""
    w, h = round(width * PIXELS_PER_METER), round(height * PIXELS_PER_METER)
    value = np.zeros((h, w), np.float32)
    for cell_size, contrast in [(65, 14), (11, 13), (3, 9)]:
        cells = rng.normal(0, contrast, (h // cell_size + 1, w // cell_size + 1)).astype(np.float32)
        value += cv2.resize(cells, (w, h), interpolation=cv2.INTER_CUBIC)
    result = np.clip(value[..., None] + color, 0, 255).astype(np.uint8)
    return result


def materials():
    # OpenCV uses BGR. The back wall has a gold door with a clearly labeled blue plaque.
    rng = np.random.default_rng(31)
    floor = surface(HALL_WIDTH, HALL_LENGTH, (95, 93, 85), rng)
    for x in range(0, floor.shape[1], 105):
        cv2.line(floor, (x, 0), (x, floor.shape[0]), (54, 53, 51), 3)
    for y in range(0, floor.shape[0], 105):
        cv2.line(floor, (0, y), (floor.shape[1], y), (54, 53, 51), 3)
    ceiling = surface(HALL_WIDTH, HALL_LENGTH, (180, 185, 182), rng)
    for z in range(170, ceiling.shape[0], 380):
        cv2.rectangle(ceiling, (310, z), (475, z + 65), (103, 108, 110), -1)
        cv2.rectangle(ceiling, (317, z + 7), (468, z + 58), (240, 244, 242), -1)

    walls = []
    for wall_id in range(2):
        wall = surface(HALL_LENGTH, HALL_HEIGHT, (158, 168, 165), rng)
        wall[-22:] = (77, 80, 74)
        for panel, x in enumerate(range(140 + wall_id * 133, wall.shape[1] - 180, 270)):
            tint = tuple(map(int, rng.integers(55, 205, 3)))
            cv2.rectangle(wall, (x - 4, 149), (x + 161, 329), (52, 53, 54), -1)
            cv2.rectangle(wall, (x, 153), (x + 157, 325), tint, -1)
            cv2.putText(wall, f'{chr(65 + wall_id)}-{panel}', (x + 9, 201),
                        cv2.FONT_HERSHEY_DUPLEX, 1.2, (239, 238, 231), 3, cv2.LINE_AA)
            for _ in range(17):
                cx, cy = x + rng.integers(12, 145), rng.integers(218, 312)
                ink = tuple(map(int, rng.integers(30, 242, 3)))
                cv2.circle(wall, (int(cx), int(cy)), int(rng.integers(3, 10)), ink, -1)
        walls.append(wall)

    back = surface(HALL_WIDTH, HALL_HEIGHT, (158, 168, 165), rng)
    cv2.rectangle(back, (282, 108), (533, back.shape[0]), (33, 43, 47), -1)
    door = surface(1.08, 2.25, (38, 157, 225), rng)
    back[119:119 + door.shape[0], 289:289 + door.shape[1]] = door
    cv2.rectangle(back, (316, 168), (500, 250), (113, 58, 22), -1)
    cv2.putText(back, 'EXIT 27', (324, 223), cv2.FONT_HERSHEY_DUPLEX, 1.27,
                (244, 245, 245), 3, cv2.LINE_AA)
    cv2.circle(back, (497, 393), 9, (51, 56, 57), -1)
    return [*walls, floor, ceiling, back]


def camera_pose(progress):
    # The pinhole camera advances and weaves sideways to provide triangulation baselines.
    phase = 2 * math.pi * progress
    camera_x = HALL_WIDTH / 2 + 0.64 * math.sin(1.4 * phase - 0.6)
    camera_y = 1.46 + 0.06 * math.sin(2 * phase)
    camera_z = 0.9 + 5.8 * progress
    yaw = -0.16 * (camera_x - HALL_WIDTH / 2) + 0.10 * math.sin(0.8 * phase)
    return (camera_x, camera_y, camera_z), yaw


def render(textures, rays_x, rays_y, progress):
    (camera_x, camera_y, camera_z), yaw = camera_pose(progress)
    dx = rays_x * math.cos(yaw) + math.sin(yaw)
    dz = math.cos(yaw) - rays_x * math.sin(yaw)
    with np.errstate(divide='ignore'):
        tx = np.where(dx < 0, -camera_x, HALL_WIDTH - camera_x) / dx
        ty = np.where(rays_y < 0, -camera_y, HALL_HEIGHT - camera_y) / rays_y
        tz = (HALL_LENGTH - camera_z) / dz
    distance = np.minimum(np.minimum(tx, ty), tz)
    x = camera_x + dx * distance
    y = camera_y + rays_y * distance
    z = camera_z + dz * distance

    # Select texture coordinates on the nearest intersected surface.
    side = (tx < ty) & (tx < tz)
    horizontal = (~side) & (ty < tz)
    faces = np.where(side, (dx >= 0).astype(int), np.where(horizontal, 2 + (rays_y >= 0), 4))
    u = np.where(side, z, x) * PIXELS_PER_METER
    v = np.where(horizontal, z, HALL_HEIGHT - y) * PIXELS_PER_METER
    u, v = u.astype(np.float32), v.astype(np.float32)
    result = np.empty((HEIGHT, WIDTH, 3), np.uint8)
    for index, texture in enumerate(textures):
        mask = faces == index
        projected = cv2.remap(texture, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        result[mask] = projected[mask]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='New .mp4 file, for example captures-local/synthetic.mp4')
    args = parser.parse_args()
    if args.output.suffix.lower() != '.mp4' or args.output.exists():
        parser.error('Choose a new output path ending in .mp4')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    ys, xs = np.indices((HEIGHT, WIDTH), dtype=np.float32)
    rays_x = (xs - (WIDTH - 1) / 2) / 580
    rays_y = ((HEIGHT - 1) / 2 - ys) / 580
    textures = materials()
    command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-n', '-f', 'rawvideo',
               '-pix_fmt', 'bgr24', '-s', f'{WIDTH}x{HEIGHT}', '-r', str(FPS), '-i', '-',
               '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt',
               'yuv420p', '-movflags', '+faststart']
    with TemporaryDirectory(dir=args.output.parent) as workspace:
        clip = Path(workspace) / 'hallway.mp4'
        with subprocess.Popen([*command, str(clip)], stdin=subprocess.PIPE) as encoder:
            for i in range(FPS * SECONDS):
                frame = render(textures, rays_x, rays_y, i / (FPS * SECONDS - 1))
                encoder.stdin.write(frame.tobytes())
            encoder.stdin.close()
            if encoder.wait():
                raise SystemExit('ffmpeg could not write the synthetic clip')
        clip.rename(args.output)
    print(args.output)


if __name__ == '__main__':
    main()
