"""Exercise phone motion timing, reconstruction choice and actual streaming containers."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recorded_take as take


def track(times, rate=90):
    return {
        "version": 1, "timebase": "recording-start-ms", "durationMs": 1000,
        "permission": "granted",
        "samples": [{"tMs": t, "rotationRate": {"alpha": rate, "beta": 0, "gamma": 0},
                     "acceleration": {"x": -2, "y": 0, "z": 0},
                     "accelerationIncludingGravity": {"x": -2, "y": 9.8, "z": 0}}
                    for t in times],
    }


class CaptureTest(unittest.TestCase):
    def test_motion_sampling(self):
        summary = take.validate_motion(track(range(0, 1001, 20)))
        self.assertEqual(summary["gyroCoverageFraction"], 1)
        self.assertEqual(summary["accelerationSampleCount"], 51)
        self.assertEqual(summary["peakLinearAccelerationMps2"], 2)
        self.assertEqual(take._sampling(summary, 1)[0], take.DENSE)
        self.assertEqual(take._sampling(summary, 5)[0], take.DEFAULT)
        sparse = take.validate_motion(track([0, 20, 970, 1000]))
        self.assertEqual(sparse["gyroCoverageFraction"], .05)
        self.assertFalse(sparse["rotationWindows"])
        self.assertEqual(take._sampling(sparse, 1)[0], take.DEFAULT)

    def test_invalid_samples_and_video_only(self):
        denied = {**track([]), "permission": "denied"}
        self.assertEqual(take.validate_motion(denied)["sampleCount"], 0)
        for data in [track([1010]), track([1, 0]), track([0], float("nan")),
                     track([0], True), {**track([0]), "permission": "unavailable"}]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                take.validate_motion(data)

    def test_selects_a_complete_mesh_by_supported_camera_coverage(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "motion.json").write_text(json.dumps(track(range(0, 1001, 20))))
            attempts = [
                {"status": "ready", "run": "dense", "supportedFraction": .6},
                {"status": "ready", "run": "default", "supportedFraction": .95},
            ]
            with patch.object(take, "_prepare_video", return_value=(root / "video.mov", 1)), \
                    patch.object(take, "_run", side_effect=attempts) as runner:
                asset = take.process_capture(root, root / "hallway3d", lambda step: None)
            self.assertEqual([c.args[3] for c in runner.call_args_list], [take.DENSE, take.DEFAULT])
            self.assertEqual(asset.parts[-3:], ("default", "mesh", "hallway.glb"))
            self.assertEqual(json.loads((root / "motion-summary.json").read_text())["selectedRun"], "default")

    def test_seekable_recordings_from_browser_containers(self):
        for container, codec, flags in [("webm", "libvpx", ["-live", "1"]),
                                        ("mp4", "libx264", ["-movflags", "empty_moov+frag_keyframe"])]:
            with self.subTest(container=container), tempfile.TemporaryDirectory() as folder:
                job = Path(folder)
                with (job / "input.video").open("wb") as sink:
                    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                                    "testsrc2=size=96x64:rate=20", "-t", "1", "-c:v", codec,
                                    *flags, "-f", container, "pipe:1"], stdout=sink, check=True)
                video, duration = take._prepare_video(job / "input.video", job)
                self.assertTrue(video.is_file())
                self.assertAlmostEqual(duration, 1.0, delta=.13)


if __name__ == "__main__":
    unittest.main()
