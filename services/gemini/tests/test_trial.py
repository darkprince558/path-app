"""Trial runner: folder loading, runs, decisions, report, privacy guard (no network)."""

import io
import json
from pathlib import Path

import pytest

from conftest import PACKAGE_DIR, candidate, make_service, response_json

from fixtures.synthetic_frames import scene_frames
from path_gemini import ConfigurationError, GeminiRateLimitedError
from path_gemini.trial.cli import main
from path_gemini.trial.inputs import TrialInputError, find_frame, load_frames, read_image
from path_gemini.trial.runlog import record_decision, summarize

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402


def _jpeg(color=(120, 40, 160), size=(64, 48), exif=None) -> bytes:
    buf = io.BytesIO()
    img = Image.new("RGB", size, color)
    if exif is not None:
        img.save(buf, format="JPEG", exif=exif)
    else:
        img.save(buf, format="JPEG")
    return buf.getvalue()


def keyframes_folder(tmp_path: Path) -> Path:
    folder = tmp_path / "take"
    folder.mkdir()
    items = []
    for i in range(4):
        (folder / "photo-{}.jpg".format(i)).write_bytes(_jpeg((40 * i, 80, 120)))
        items.append({"camera": {"t": 1000.0 + i * 0.8, "cameraToWorld": [1] * 16, "intrinsics": [1] * 9,
                                 "imageWidth": 64, "imageHeight": 48, "tracking": "normal" if i != 3 else "limited"},
                      "jpeg": "photo-{}.jpg".format(i)})
    (folder / "keyframes.json").write_text(json.dumps(items), encoding="utf-8")
    return folder


def run_cli(argv, service=None, factory=None):
    out = io.StringIO()
    code = main(argv, service_factory=factory or (lambda: service), out=out)
    return code, out.getvalue()


# ------------------------------------------------------------------ inputs ---


def test_keyframes_layout(tmp_path):
    layout, frames = load_frames(keyframes_folder(tmp_path))
    assert layout == "keyframes.json"
    assert [f.frame_id for f in frames] == ["photo-0", "photo-1", "photo-2", "photo-3"]
    assert frames[0].timestamp_seconds == 0.0 and frames[2].timestamp_seconds == pytest.approx(1.6)
    assert frames[3].tracking == "limited" and frames[0].mime_type == "image/jpeg"


def test_frames_json_layout(tmp_path):
    images = scene_frames("landmark")
    (tmp_path / "frames").mkdir()
    entries = []
    for i, role in enumerate(["approach", "junction", "exit"]):
        name = "frames/frame-00014{}.png".format(i)
        (tmp_path / name).write_bytes(images[role])
        entries.append({"frameId": "frame-00014{}".format(i), "imagePath": name, "mimeType": "image/png",
                        "timestampSeconds": 8 + i, "trackingState": "normal"})
    (tmp_path / "frames.json").write_text(json.dumps({"frames": entries}), encoding="utf-8")
    layout, frames = load_frames(tmp_path)
    assert layout == "frames.json" and [f.frame_id for f in frames][0] == "frame-000140"


def test_plain_image_folder_and_lookup(tmp_path):
    (tmp_path / "IMG 2053.JPG").write_bytes(_jpeg())
    (tmp_path / "b.png").write_bytes(scene_frames("blank")["exit"])
    (tmp_path / "notes.txt").write_text("ignored")
    layout, frames = load_frames(tmp_path)
    assert layout == "images" and [f.frame_id for f in frames] == ["b", "IMG-2053"]
    assert find_frame(frames, "IMG 2053.JPG").frame_id == "IMG-2053"
    with pytest.raises(TrialInputError):
        find_frame(frames, "missing")


def test_path_escape_and_empty_folder_rejected(tmp_path):
    (tmp_path / "keyframes.json").write_text(json.dumps([{"jpeg": "../secret.jpg", "camera": {}}]))
    with pytest.raises(TrialInputError):
        load_frames(tmp_path)
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(TrialInputError):
        load_frames(empty)


def test_read_image_strips_exif_and_downscales(tmp_path):
    exif = Image.Exif()
    exif[0x010F] = "SECRET-CAMERA-MAKER"  # Make
    exif[0x8825] = {2: (43.0, 0.0, 0.0)}  # GPS IFD: latitude
    path = tmp_path / "big.jpg"
    path.write_bytes(_jpeg(size=(3000, 2000), exif=exif))
    _, frames = load_frames(tmp_path)
    data, mime, info = read_image(frames[0], max_side=1280, max_bytes=5_000_000)
    assert mime == "image/jpeg" and info["normalized"] and max(info["width"], info["height"]) == 1280
    assert b"SECRET-CAMERA-MAKER" not in data
    with Image.open(io.BytesIO(data)) as img:
        assert not img.getexif()


def test_unsupported_and_unreadable_images(tmp_path):
    (tmp_path / "a.heic").write_bytes(b"x")
    (tmp_path / "keyframes.json").write_text(json.dumps([{"jpeg": "a.heic", "camera": {}}]))
    with pytest.raises(TrialInputError):
        load_frames(tmp_path)
    other = tmp_path / "o"
    other.mkdir()
    (other / "broken.jpg").write_bytes(b"\xff\xd8\xff not really")
    _, frames = load_frames(other)
    with pytest.raises(TrialInputError):
        read_image(frames[0], max_side=100, max_bytes=10)


# -------------------------------------------------------------------- runs ---


def _run(tmp_path, script, *extra, label="Check-in <b>to</b> lab"):
    service, _ = make_service(script)
    folder = keyframes_folder(tmp_path)
    log = tmp_path / "log"
    code, out = run_cli(["run", str(folder), "--maneuver", "left", "--approach", "photo-0", "--junction",
                         "photo-1", "--exit", "photo-2.jpg", "--label", label, "--log-dir", str(log), *extra],
                        service)
    runs = sorted(p for p in log.iterdir()) if log.exists() else []
    return code, out, runs, service


def test_run_writes_result_images_and_escaped_report(tmp_path):
    script = [response_json([candidate(frames=("photo-0", "photo-1"))])]
    code, out, runs, service = _run(tmp_path, script)
    assert code == 0 and len(runs) == 1
    run = runs[0]
    assert "[0] Turn left after the purple mural." in out
    result = json.loads((run / "result.json").read_text())
    assert result["category"] == "CANDIDATES" and result["promptVersion"] == "landmark-v1"
    meta = json.loads((run / "run.json").read_text())
    assert [f["role"] for f in meta["frames"]] == ["approach", "junction", "exit"]
    assert sorted(p.name for p in (run / "images").iterdir()) == [
        "approach-photo-0.jpg", "exit-photo-2.jpg", "junction-photo-1.jpg"]
    html = (run / "report.html").read_text(encoding="utf-8")
    assert html.count("data:image/jpeg;base64,") == 3
    assert "Turn left after the purple mural." in html and "Check-in &lt;b&gt;to&lt;/b&gt; lab" in html
    assert "<b>to</b>" not in html and "http" not in html.split("</style>")[1].split("Turn left")[0]
    # Prompt saw the verified maneuver and labels in walking order.
    labels = [p.text for p in service.client.prompts[0].parts if p.kind == "text" and p.frame_id]
    assert [lbl.split("role=")[1].split()[0] for lbl in labels] == ["approach", "junction", "exit"]


def test_two_frame_run_and_role_validation(tmp_path):
    service, _ = make_service([response_json([candidate(frames=("photo-0",))])])
    folder = keyframes_folder(tmp_path)
    code, _ = run_cli(["run", str(folder), "--maneuver", "left", "--approach", "photo-0", "--junction", "photo-1",
                       "--log-dir", str(tmp_path / "log")], service)
    assert code == 0
    code, _ = run_cli(["run", str(folder), "--maneuver", "left", "--junction", "photo-1",
                       "--log-dir", str(tmp_path / "log2")], service)
    assert code == 1 and not (tmp_path / "log2").exists()
    code, _ = run_cli(["run", str(folder), "--maneuver", "left", "--approach", "photo-1", "--junction", "photo-1",
                       "--log-dir", str(tmp_path / "log3")], service)
    assert code == 1


def test_failed_run_is_recorded(tmp_path):
    code, out, runs, _ = _run(tmp_path, [GeminiRateLimitedError(provider_status=429)] * 3)
    assert code == 2 and "FAILED GEMINI_RATE_LIMITED" in out
    error = json.loads((runs[0] / "error.json").read_text())
    assert error["code"] == "GEMINI_RATE_LIMITED" and error["attempts"] == 3
    assert "Failed: GEMINI_RATE_LIMITED" in (runs[0] / "report.html").read_text(encoding="utf-8")


def test_missing_key_writes_nothing(tmp_path):
    def factory():
        raise ConfigurationError("GEMINI_API_KEY is not set on the server.")
    folder = keyframes_folder(tmp_path)
    code, _ = run_cli(["run", str(folder), "--maneuver", "left", "--approach", "photo-0", "--junction", "photo-1",
                       "--log-dir", str(tmp_path / "log"), "--env-file", str(tmp_path / "none.env")],
                      factory=factory)
    assert code == 1 and not (tmp_path / "log").exists()


def test_refuses_tracked_output_inside_repo(tmp_path):
    service, _ = make_service([response_json()])
    folder = keyframes_folder(tmp_path)
    target = PACKAGE_DIR / "tmp-trial-should-not-exist"
    code, _ = run_cli(["run", str(folder), "--maneuver", "left", "--approach", "photo-0", "--junction", "photo-1",
                       "--log-dir", str(target)], service)
    assert code == 1 and not target.exists() and service.client.calls == 0


# --------------------------------------------------------------- decisions ---


def test_decisions_and_summary(tmp_path):
    log = tmp_path / "log"
    folder = keyframes_folder(tmp_path)
    scripts = [
        response_json([candidate(frames=("photo-0",)), candidate(landmark="bench", frames=("photo-1",),
                                                                  instruction="Turn left after the bench.")]),
        response_json([candidate(frames=("photo-1",))]),
        response_json([candidate(frames=("photo-1",))]),
        response_json([], abstained=True, reason="Plain walls only."),
        response_json([], abstained=True, reason="Plain walls only."),
        [GeminiRateLimitedError()] * 3,
    ]
    for script in scripts:
        service, _ = make_service(script if isinstance(script, list) else [script])
        run_cli(["run", str(folder), "--maneuver", "left", "--approach", "photo-0", "--junction", "photo-1",
                 "--log-dir", str(log)], service)
    runs = sorted(log.iterdir())
    assert len(runs) == 6

    assert run_cli(["decide", str(runs[0]), "accept", "--candidate", "1"])[0] == 0
    code, out = run_cli(["decide", str(runs[1]), "edit", "--text", "Turn left at the purple mural by the stairs."])
    assert code == 0 and "purple mural by the stairs" in out
    assert run_cli(["decide", str(runs[2]), "reject", "--note", "mural is temporary"])[0] == 0
    assert run_cli(["decide", str(runs[3]), "agree"])[0] == 0
    assert run_cli(["decide", str(runs[4]), "manual", "--text", "Turn left at the red fire door."])[0] == 0
    # Invalid decisions are refused.
    assert run_cli(["decide", str(runs[3]), "accept"])[0] == 1
    assert run_cli(["decide", str(runs[0]), "agree"])[0] == 1
    assert run_cli(["decide", str(runs[1]), "edit"])[0] == 1
    assert run_cli(["decide", str(runs[0]), "accept", "--candidate", "5"])[0] == 1

    decision = json.loads((runs[0] / "decision.json").read_text())
    assert decision["approvedText"] == "Turn left after the bench."
    assert "Turn left after the bench." in (runs[0] / "report.html").read_text(encoding="utf-8")

    counts = summarize(log)
    assert counts == {"runs": 6, "withCandidates": 3, "candidatesSuggested": 4, "abstained": 2, "failed": 1,
                      "accepted": 1, "edited": 1, "rejected": 1, "abstentionAgreed": 1, "manual": 1, "pending": 1}
    code, out = run_cli(["summary", "--log-dir", str(log)])
    assert code == 0 and "Across 6 turn trials" in out and "accepted 1 unchanged" in out


def test_record_decision_rejects_non_run_folder(tmp_path):
    with pytest.raises(ValueError):
        record_decision(tmp_path, "reject")


def test_list_command(tmp_path):
    code, out = run_cli(["list", str(keyframes_folder(tmp_path))])
    assert code == 0 and "4 frames from keyframes.json" in out and "[tracking: limited]" in out
