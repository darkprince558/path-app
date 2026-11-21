"""Opt-in real Gemini call against synthetic or approved images.

Skipped unless BOTH are set (in the environment or services/gemini/.env):

    GEMINI_API_KEY=...
    RUN_LIVE_GEMINI_TESTS=1

By default it sends the synthetic frames from fixtures/synthetic_frames.py.
To try approved photos instead, set GEMINI_LIVE_FIXTURE_DIR to a folder OUTSIDE
Git containing fixture.json (same shape as fixtures/synthetic_left_turn.json,
with each frame's "imagePath" relative to that folder).

Assertions cover stable properties only, never exact prose.
"""

import json
import os
from pathlib import Path

import pytest

from fixtures.synthetic_frames import scene_frames
from path_gemini import (
    PROMPT_VERSION,
    GeminiConfig,
    LandmarkRequest,
    LandmarkService,
    Maneuver,
    ResultCategory,
)
from path_gemini.validation import detect_maneuver_families

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "synthetic_left_turn.json"

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not (os.environ.get("GEMINI_API_KEY") and os.environ.get("RUN_LIVE_GEMINI_TESTS") == "1"),
        reason="live Gemini test needs GEMINI_API_KEY and RUN_LIVE_GEMINI_TESTS=1",
    ),
]


def _synthetic_request(scene: str, request_id: str) -> LandmarkRequest:
    meta = json.loads(FIXTURE.read_text(encoding="utf-8"))
    meta.pop("description", None)
    images = scene_frames(scene)
    for frame in meta["frames"]:
        frame["imageBytes"] = images[frame["role"]]
    meta["requestId"] = request_id
    return LandmarkRequest.model_validate(meta)


def _approved_request(folder: Path) -> LandmarkRequest:
    meta = json.loads((folder / "fixture.json").read_text(encoding="utf-8"))
    meta.pop("description", None)
    for frame in meta["frames"]:
        frame["imageBytes"] = (folder / frame.pop("imagePath")).read_bytes()
    return LandmarkRequest.model_validate(meta)


def _cases():
    folder = os.environ.get("GEMINI_LIVE_FIXTURE_DIR")
    if folder:
        return [("approved", lambda: _approved_request(Path(folder)))]
    return [
        ("synthetic-landmark", lambda: _synthetic_request("landmark", "req-live-landmark")),
        ("synthetic-blank", lambda: _synthetic_request("blank", "req-live-blank")),
    ]


@pytest.fixture(scope="module")
def service():
    return LandmarkService(GeminiConfig.from_env())


@pytest.mark.parametrize("name,build", _cases(), ids=[c[0] for c in _cases()])
def test_live_structured_landmark_request(service, name, build):
    request = build()
    result = service.propose_landmarks(request)

    assert result.model == service.config.model
    assert result.prompt_version == PROMPT_VERSION
    assert result.elapsed_ms > 0 and result.attempts >= 1
    assert result.requires_review is True
    assert result.fingerprint.startswith("sha256:")
    known = {f.frame_id for f in request.frames}
    maneuver = request.verified_movement.maneuver
    if result.category is ResultCategory.NO_CLEAR_LANDMARK:
        assert result.abstained and not result.candidates and result.abstention_reason
    else:
        assert 1 <= len(result.candidates) <= 3
        for cand in result.candidates:
            assert set(cand.source_frame_ids) <= known
            if maneuver is not Maneuver.ARRIVE:
                assert detect_maneuver_families(cand.instruction) == {maneuver.value}

    # Printed with -s for the verification notes. No image data is included.
    print("\nLIVE {}: model={} modelVersion={} prompt={} category={} elapsedMs={} attempts={} usage={}".format(
        name, result.model, result.model_version, result.prompt_version, result.category.value,
        result.elapsed_ms, result.attempts, result.usage.model_dump() if result.usage else None))
    for cand in result.candidates:
        print("  candidate: {!r} frames={} visibility={} instruction={!r}".format(
            cand.landmark, cand.source_frame_ids, cand.visibility.value, cand.instruction))
    if result.abstained:
        print("  abstained: {!r}".format(result.abstention_reason))
