import base64
import json
import os
from pathlib import Path
from typing import List, Optional

import pytest

from fixtures.synthetic_frames import tiny_jpeg_like, tiny_png
from path_gemini import GeminiConfig, LandmarkRequest, LandmarkService, ProviderResponse

PACKAGE_DIR = Path(__file__).resolve().parents[1]
FAKE_KEY = "test-key-NOT-A-REAL-SECRET-1234567890"


def _load_local_env() -> None:
    """Read services/gemini/.env (gitignored) for the opt-in live test only.

    Existing environment variables win. Only GEMINI_* and RUN_LIVE_GEMINI_TESTS
    are read. The package itself never loads .env files.
    """
    path = PACKAGE_DIR / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name, value = name.strip(), value.strip().strip('"').strip("'")
        if (name.startswith("GEMINI_") or name == "RUN_LIVE_GEMINI_TESTS") and name not in os.environ:
            os.environ[name] = value


_load_local_env()

PNG = tiny_png()
JPEG = tiny_jpeg_like()
SECRET_BYTES = PNG + b"SECRET-PIXEL-PAYLOAD"  # still a valid PNG prefix


def request_dict(frame_count: int = 3, maneuver: str = "left", **overrides) -> dict:
    frames = [
        {"frameId": "frame-000138", "role": "approach", "mimeType": "image/png",
         "imageBytes": SECRET_BYTES, "timestampSeconds": 7.96},
        {"frameId": "frame-000142", "role": "junction", "mimeType": "image/jpeg",
         "imageBytes": JPEG, "timestampSeconds": 8.42},
        {"frameId": "frame-000150", "role": "exit", "mimeType": "image/png",
         "imageBytes": PNG, "timestampSeconds": 9.12},
    ][:frame_count]
    data = {
        "requestId": "req-1",
        "scanRevisionId": "revision-456",
        "routeSegmentId": "segment-789",
        "approachDirectionId": "approach-a",
        "waypoints": {"approachWaypointId": "wp-16", "junctionWaypointId": "wp-17", "exitWaypointId": "wp-18"},
        "verifiedMovement": {"maneuver": maneuver, "instruction": "Turn left at the junction"},
        "frames": frames,
    }
    data.update(overrides)
    return data


def make_request(frame_count: int = 3, maneuver: str = "left", **overrides) -> LandmarkRequest:
    return LandmarkRequest.model_validate(request_dict(frame_count, maneuver, **overrides))


def candidate(instruction="Turn left after the purple mural.", frames=("frame-000138", "frame-000142"), **kw):
    c = {
        "landmark": "purple mural",
        "visibleText": None,
        "sourceFrameIds": list(frames),
        "instruction": instruction,
        "visibility": "clear",
        "reason": "Visible on the approach and at the junction.",
    }
    c.update(kw)
    return c


def response_json(candidates=None, abstained=False, reason=None) -> str:
    return json.dumps(
        {"candidates": candidates if candidates is not None else [candidate()],
         "abstained": abstained, "abstentionReason": reason}
    )


class FakeClient:
    """Scripted provider: each call pops the next item (exception or response)."""

    def __init__(self, script: List):
        self.script = list(script)
        self.calls = 0
        self.prompts = []
        self.models = []

    def generate(self, prompt, *, model):
        self.calls += 1
        self.prompts.append(prompt)
        self.models.append(model)
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, str):
            return ProviderResponse(text=item, finish_reason="STOP")
        return item


def make_service(script, max_retries: int = 2, model: str = "test-model", logger=None):
    sleeps: List[float] = []
    ticks = iter(range(0, 10_000, 1))
    service = LandmarkService(
        GeminiConfig(api_key=FAKE_KEY, model=model, max_retries=max_retries),
        client=FakeClient(script),
        sleep=sleeps.append,
        clock=lambda: next(ticks) * 0.05,
        jitter=lambda: 0.5,
        logger=logger,
    )
    return service, sleeps


def forbidden_strings() -> List[str]:
    """Strings that must never appear in logs or error text."""
    out = [FAKE_KEY, "SECRET-PIXEL-PAYLOAD", base64.b64encode(SECRET_BYTES).decode()[:24],
           base64.b64encode(PNG).decode()[:24]]
    return out


@pytest.fixture
def secrets_out():
    return forbidden_strings()


def assert_clean(text: str, needles: Optional[List[str]] = None) -> None:
    for needle in needles or forbidden_strings():
        assert needle not in text, "leaked: " + needle[:8]
    assert "\\x89PNG" not in text and "b'\\x89" not in text
