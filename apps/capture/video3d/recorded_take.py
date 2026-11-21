"""Process a website take with the existing hallway3d executable on the Mac."""

import json
import math
from pathlib import Path
import subprocess
import tempfile


MAX_DURATION_MS = 95_000  # The phone stops at 90 s; allow recorder finalization.
MAX_SAMPLES = 30_000
DEFAULT = (8, 160)
DENSE = (12, 360)


class CaptureError(RuntimeError):
    """Short processing diagnostic suitable for the organizer's status page."""


def number(value, field):
    if type(value) not in (int, float):
        raise ValueError(f"Expected a finite number for {field}.")
    try:
        if math.isfinite(value):
            return value
    except OverflowError:
        pass
    raise ValueError(f"Expected a finite number for {field}.")


def magnitude(vector, axes):
    if vector is None:
        return None
    if not isinstance(vector, dict):
        raise ValueError("Expected a sensor vector or null.")
    speed = math.hypot(*(number(vector.get(axis), axis) for axis in axes))
    return number(speed, "vector magnitude")


def validate_motion(data):
    """Validate W3C orientation-independent magnitudes. Gaps break gyro coverage."""
    if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1:
        raise ValueError("Unsupported recording motion format.")
    if data.get("timebase") != "recording-start-ms":
        raise ValueError("Motion times must be relative to the recording start.")
    permission = data.get("permission")
    if permission not in ("granted", "denied", "unavailable"):
        raise ValueError("Invalid motion permission.")
    duration = number(data.get("durationMs"), "durationMs")
    if not 0 < duration <= MAX_DURATION_MS:
        raise ValueError("Recording duration must be positive and within 95 seconds.")
    samples = data.get("samples")
    if not isinstance(samples, list) or len(samples) > MAX_SAMPLES:
        raise ValueError("Invalid motion sample list.")
    if permission != "granted" and samples:
        raise ValueError("Motion samples require granted permission.")

    gyro_count = accel_count = gravity_count = 0
    gyro_ms = accel_ms = 0.0
    peak_linear = None
    previous_t = previous_gyro = previous_accel = None
    windows = []
    window = None
    for sample in samples:
        if not isinstance(sample, dict):
            raise ValueError("Invalid motion sample.")
        t = number(sample.get("tMs"), "tMs")
        if not 0 <= t <= duration or (previous_t is not None and t < previous_t):
            raise ValueError("Motion times must increase within the recording.")
        gyro = magnitude(sample.get("rotationRate"), ("alpha", "beta", "gamma"))
        accel = magnitude(sample.get("acceleration"), ("x", "y", "z"))
        gravity = magnitude(sample.get("accelerationIncludingGravity"), ("x", "y", "z"))
        gyro_count += gyro is not None
        accel_count += accel is not None
        gravity_count += gravity is not None
        if accel is not None:
            peak_linear = accel if peak_linear is None else max(accel, peak_linear)
        dt = t - previous_t if previous_t is not None else 0
        linked = previous_t is not None and dt <= 250
        if linked and gyro is not None and previous_gyro is not None:
            gyro_ms += dt
        if linked and accel is not None and previous_accel is not None:
            accel_ms += dt

        # A single shake or a delivery gap is insufficient to change the video preset.
        if window is not None and (not linked or gyro is None or gyro < 35):
            if window["endMs"] - window["startMs"] >= 250:
                windows.append(window)
            window = None
        if gyro is not None and gyro >= 35:
            if window is None:
                window = {"startMs": t, "endMs": t, "peakDegreesPerSecond": gyro}
            else:
                window["endMs"] = t
                window["peakDegreesPerSecond"] = max(window["peakDegreesPerSecond"], gyro)
        previous_t, previous_gyro, previous_accel = t, gyro, accel
    if window is not None and window["endMs"] - window["startMs"] >= 250:
        windows.append(window)
    return {
        "permission": permission, "durationMs": duration, "sampleCount": len(samples),
        "gyroSampleCount": gyro_count, "accelerationSampleCount": accel_count,
        "accelerationIncludingGravitySampleCount": gravity_count,
        "gyroCoverageFraction": round(gyro_ms / duration, 4),
        "accelerationCoverageFraction": round(accel_ms / duration, 4),
        "peakLinearAccelerationMps2": peak_linear, "rotationWindows": windows,
    }


def _prepare_video(source, attempt):
    # MediaRecorder can emit streaming WebM without a Duration element. Remux its video
    # packets into a seekable container; keep the original timestamps, rotation and pixels.
    with source.open("rb") as stream:
        signature = stream.read(12)
    if signature.startswith(bytes.fromhex("1a45dfa3")):
        demuxer, suffix = "matroska", ".mkv"
    elif signature[4:8] in (b"ftyp", b"moov", b"mdat", b"wide", b"free"):
        demuxer, suffix = "mov", ".mov"
    else:
        raise CaptureError("The recording is not a supported MP4, MOV or WebM video.")
    video = attempt / ("camera" + suffix)
    try:
        with (attempt / "video.log").open("w") as log:
            # Select the actual movie demuxer. Never probe an upload as a playlist.
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file",
                            "-f", demuxer, "-i", str(source), "-map", "0:V:0", "-c:v", "copy",
                            "-map_metadata", "-1", "-an", "-dn", "-sn", str(video)],
                           check=True, timeout=90, stdout=log, stderr=log)
            meta = json.loads(subprocess.check_output([
                "ffprobe", "-v", "error", "-select_streams", "V:0", "-show_entries",
                "stream=width,height:format=duration", "-of", "json", str(video)], stderr=log, timeout=30))
        duration = float(meta["format"]["duration"])
        stream = meta["streams"][0]
        if not 0 < duration <= MAX_DURATION_MS / 1000 or not 0 < stream["width"] * stream["height"] <= 4096*2160:
            raise CaptureError("Record up to 90 seconds of video at 4K resolution or lower.")
    except (subprocess.SubprocessError, KeyError, IndexError, ValueError) as exc:
        raise CaptureError("The Mac could not read this recording. Try a new camera take.") from exc
    return video, duration


def _sampling(summary, duration):
    if abs(duration - summary["durationMs"] / 1000) > max(1.0, 0.05 * duration):
        return DEFAULT, "Motion and video durations disagree; using the video preset."
    if summary["gyroCoverageFraction"] < 0.6:
        return DEFAULT, "Insufficient continuous gyro samples; using the video preset."
    base_fps = min(DEFAULT[0], DEFAULT[1] / duration)
    # If camera rotation could exceed eight degrees between ordinary keyframes, shorten
    # their spacing. Event and exposure timestamps are approximate, so keep uniform
    # sampling across the take. Never turn handset acceleration into camera positions.
    if any(w["peakDegreesPerSecond"] / base_fps > 8 for w in summary["rotationWindows"]):
        return DENSE, "Sustained phone rotation increases the keyframe budget."
    return DEFAULT, "The ordinary keyframe budget covers the measured rotation."


_STAGES = {
    "1/3 ": "Sampling camera frames", "2/3 ": "Tracking the camera path",
    "Estimating and fusing": "Estimating and fusing depth",
    "1/4 ": "Cleaning the point cloud", "2/4 ": "Reconstructing the surface",
    "3/4 ": "Removing unsupported geometry", "4/4 ": "Baking photo textures",
}


def _run(pipeline, video, parent, preset, progress):
    fps, cap = preset
    run = parent / f"fps-{fps}-cap-{cap}"
    options = [str(pipeline), str(video), "--surface", "mesh", "--no-preview",
               "--fps", str(fps), "--max-frames", str(cap), "--output", str(run)]
    with (parent / (run.name + ".log")).open("w", buffering=1) as log:
        with subprocess.Popen(options, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, errors="replace") as proc:
            for line in proc.stdout:
                log.write(line)
                stage = next((s for prefix, s in _STAGES.items() if line.startswith(prefix)), None)
                if stage:
                    progress(stage)
            code = proc.wait()
    path = run / "mesh/hallway.glb"
    if code or not path.is_file():
        return {"run": run.name, "status": "failed"}
    report = json.loads((run / "report.json").read_text())
    tracking = report["reconstruction"]
    coverage = tracking["supported_frames"] / tracking["input_frames"]
    return {"run": run.name, "status": "ready", "supportedFraction": coverage,
            "registeredFrames": tracking["registered_frames"], "sampledFrames": tracking["input_frames"],
            "missingIntervalsSeconds": report["unregistered_intervals_seconds"]}


def _write_summary(path, summary):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as out:
        json.dump(summary, out, allow_nan=False, indent=2)
        out.write("\n")
    Path(out.name).replace(path)


def process_capture(job, pipeline, progress):
    """Consume immutable input.video + motion.json. All attempts remain private to job."""
    job, pipeline = Path(job).resolve(), Path(pipeline).resolve()
    attempt = Path(tempfile.mkdtemp(prefix="reconstruction-", dir=job))
    progress("Checking the recording and motion data")
    try:
        summary = validate_motion(json.loads((job / "motion.json").read_text()))
        video, duration = _prepare_video(job / "input.video", attempt)
    except ValueError as exc:
        raise CaptureError("The recording has invalid motion data.") from exc
    except FileNotFoundError as exc:
        raise CaptureError("A capture file or FFmpeg tool is missing on the Mac.") from exc
    preset, reason = _sampling(summary, duration)
    summary.update(videoDurationSeconds=duration, samplingReason=reason, attempt=attempt.name, trials=[])
    summary_path = job / "motion-summary.json"
    _write_summary(summary_path, summary)
    try:
        trial = _run(pipeline, video, attempt, preset, progress)
    except OSError as exc:
        raise CaptureError("The Mac could not start or save the reconstruction. Check its local tools and storage.") from exc
    summary["trials"].append(trial)
    _write_summary(summary_path, summary)
    # Compare equal-time coverage of triangulation-supported cameras across rates.
    if trial["status"] == "failed" or trial["supportedFraction"] < 0.95:
        progress("Checking camera coverage with another keyframe budget")
        alternate = DEFAULT if preset == DENSE else DENSE
        try:
            retried = _run(pipeline, video, attempt, alternate, progress)
        except OSError:
            # The first mesh is still usable if the alternate cannot be started.
            retried = {"run": f"fps-{alternate[0]}-cap-{alternate[1]}", "status": "failed"}
        summary["trials"].append(retried)
    successful = [r for r in summary["trials"] if r["status"] == "ready"]
    if not successful:
        _write_summary(summary_path, summary)
        raise CaptureError("No textured mesh was recovered. Check the Mac job logs or record with more overlapping views.")
    selected = max(successful, key=lambda r: r["supportedFraction"])
    summary["selectedRun"] = selected["run"]
    _write_summary(summary_path, summary)
    return attempt / selected["run"] / "mesh/hallway.glb"
