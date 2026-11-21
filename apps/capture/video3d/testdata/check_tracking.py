"""Verify full-rate mapping against a rotated video with a VFR timestamp gap."""

from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reconstruct import extract_frames
import tracking


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", *map(str, args)], check=True)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        video = root / "portrait.mov"
        frames = root / "frames"
        reference = root / "reference"
        reference.mkdir()
        ffmpeg("-f", "lavfi", "-i", "testsrc2=rate=30:duration=4:size=320x180",
               "-vf", "select='not(between(n,21,42))'", "-fps_mode", "vfr",
               "-pix_fmt", "yuv420p", "-c:v", "libx264", root / "vfr.mp4")
        ffmpeg("-display_rotation", "90", "-i", root / "vfr.mp4", "-c", "copy", video)
        info = extract_frames(video, frames, 8, 64)
        indices = tracking._source_indices(video, frames, info, root, info["sampled_frames"])
        assert (info["sample_width"], info["sample_height"]) == (180, 320)
        assert len(set(indices)) < len(indices)  # fps duplicated an input across the timestamp gap

        ffmpeg("-i", video, "-fps_mode", "passthrough", "-q:v", "2", "-vf",
               "scale=180:320,format=rgb24,scale=out_color_matrix=bt601:out_range=full,setsar=1",
               "-pix_fmt", "yuvj444p", reference / "frame-%06d.jpg")
        for i, index in enumerate(indices):
            sampled = cv2.imread(str(frames / f"frame-{i + 1:06d}.jpg"))
            original = cv2.imread(str(reference / f"frame-{index + 1:06d}.jpg"))
            assert sampled is not None and np.array_equal(sampled, original)

        tracks, stats = tracking._video_tracks(video, info, indices)
        assert stats["flow_stride"] == 1 and len(tracks) == info["sampled_frames"]
        for i, index in enumerate(indices[1:], 1):
            if index == indices[i - 1]:
                assert np.array_equal(tracks[i][0], tracks[i - 1][0])
                assert np.array_equal(tracks[i][1], tracks[i - 1][1])
        with patch.object(tracking, "TRACK_FRAME_BUDGET", 20):
            tracks, stats = tracking._video_tracks(video, info, indices)
        assert stats["flow_stride"] > 1 and stats["flow_frames"] <= 20 + len(set(indices))
        assert len(tracks) == info["sampled_frames"]
    print("Verified decoder-frame alignment, portrait rotation, repeated samples, and bounded tracking.")


if __name__ == "__main__":
    main()
