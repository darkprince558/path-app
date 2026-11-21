"""Request validation, fingerprinting, config, and leak checks."""

import pytest
from pydantic import ValidationError

from conftest import FAKE_KEY, JPEG, PNG, assert_clean, make_request, request_dict

from path_gemini import (
    ConfigurationError,
    CorruptImageError,
    GeminiConfig,
    InvalidRequestError,
    LandmarkRequest,
    UnsupportedMediaError,
    compute_fingerprint,
)
from path_gemini.validation import validate_request

LIMIT = 10_000_000


def _validate(**kw):
    return validate_request(make_request(**kw), LIMIT)


def _with_frames(mutator, frame_count=3):
    d = request_dict(frame_count)
    mutator(d["frames"])
    return LandmarkRequest.model_validate(d)


def test_valid_three_frame_request():
    assert [f.frame_id for f in _validate()] == ["frame-000138", "frame-000142", "frame-000150"]


def test_valid_two_frame_request():
    assert len(_validate(frame_count=2)) == 2


@pytest.mark.parametrize("count", [0, 1])
def test_too_few_frames(count):
    with pytest.raises(InvalidRequestError) as e:
        _validate(frame_count=count)
    assert "expected 2 to 3 frames" in str(e.value)


def test_too_many_frames():
    d = request_dict()
    extra = dict(d["frames"][0], frameId="frame-999")
    d["frames"].append(extra)
    with pytest.raises(InvalidRequestError):
        validate_request(LandmarkRequest.model_validate(d), LIMIT)


def test_duplicate_frame_ids():
    def dup(frames):
        frames[1]["frameId"] = frames[0]["frameId"]
    with pytest.raises(InvalidRequestError) as e:
        validate_request(_with_frames(dup), LIMIT)
    assert "duplicate" in str(e.value)


@pytest.mark.parametrize("bad", ["", "   "])
def test_empty_frame_id(bad):
    def empty(frames):
        frames[0]["frameId"] = bad
    with pytest.raises(InvalidRequestError):
        validate_request(_with_frames(empty), LIMIT)


def test_duplicate_roles_rejected():
    def dup(frames):
        frames[1]["role"] = "approach"
    with pytest.raises(InvalidRequestError):
        validate_request(_with_frames(dup), LIMIT)


@pytest.mark.parametrize("mime", ["image/gif", "image/webp", "image/jpg", "application/pdf", ""])
def test_unsupported_mime(mime):
    def bad(frames):
        frames[0]["mimeType"] = mime
    with pytest.raises(UnsupportedMediaError):
        validate_request(_with_frames(bad), LIMIT)


def test_empty_bytes():
    def empty(frames):
        frames[0]["imageBytes"] = b""
    with pytest.raises(InvalidRequestError) as e:
        validate_request(_with_frames(empty), LIMIT)
    assert "empty" in str(e.value)


def test_bytes_over_limit():
    with pytest.raises(InvalidRequestError) as e:
        validate_request(make_request(), 10)
    assert "limit" in str(e.value)


def test_mime_mismatch_is_corrupt():
    def swap(frames):
        frames[0]["mimeType"] = "image/jpeg"  # bytes are PNG
    with pytest.raises(CorruptImageError):
        validate_request(_with_frames(swap), LIMIT)


def test_garbage_bytes_are_corrupt():
    def junk(frames):
        frames[2]["imageBytes"] = b"not an image at all"
    with pytest.raises(CorruptImageError):
        validate_request(_with_frames(junk), LIMIT)


@pytest.mark.parametrize("field", ["scanRevisionId", "routeSegmentId", "approachDirectionId", "requestId"])
def test_empty_identifiers(field):
    with pytest.raises(InvalidRequestError):
        _validate(**{field: ""})


def test_empty_waypoint():
    d = request_dict()
    d["waypoints"]["junctionWaypointId"] = ""
    with pytest.raises(InvalidRequestError):
        validate_request(LandmarkRequest.model_validate(d), LIMIT)


def test_identical_waypoints_rejected():
    d = request_dict()
    d["waypoints"]["exitWaypointId"] = d["waypoints"]["approachWaypointId"]
    with pytest.raises(InvalidRequestError):
        validate_request(LandmarkRequest.model_validate(d), LIMIT)


@pytest.mark.parametrize("value", ["https://storage.example.com/frame.jpg?sig=abc", "gs://bucket/frame", "www.example.com"])
def test_url_identifiers_rejected(value):
    def url(frames):
        frames[0]["frameId"] = value
    with pytest.raises(InvalidRequestError):
        validate_request(_with_frames(url), LIMIT)


def test_unknown_maneuver_rejected_without_echoing_input():
    with pytest.raises(ValidationError) as e:
        make_request(maneuver="sideways")
    assert "sideways" not in str(e.value)


def test_url_fields_are_not_accepted():
    d = request_dict()
    d["frames"][0]["imageUrl"] = "https://example.com/x.jpg"
    with pytest.raises(ValidationError):
        LandmarkRequest.model_validate(d)


def test_string_image_bytes_rejected_without_echo():
    d = request_dict()
    d["frames"][0]["imageBytes"] = "aGVsbG8gYmFzZTY0IHNlY3JldA=="
    with pytest.raises(ValidationError) as e:
        LandmarkRequest.model_validate(d)
    assert "aGVsbG8" not in str(e.value)


def test_request_repr_and_dump_exclude_bytes():
    req = make_request()
    assert_clean(repr(req))
    dumped = req.model_dump_json(by_alias=True)
    assert_clean(dumped)
    assert "imageBytes" not in dumped


def test_validation_error_text_has_no_bytes():
    def junk(frames):
        frames[0]["imageBytes"] = PNG[:4] + b"SECRET-PIXEL-PAYLOAD"
    with pytest.raises(CorruptImageError) as e:
        validate_request(_with_frames(junk), LIMIT)
    assert_clean(str(e.value))
    assert_clean(repr(e.value.to_dict()))


# ------------------------------------------------------------ fingerprint ---


def test_fingerprint_is_deterministic_and_order_independent():
    req = make_request()
    d = request_dict()
    d["frames"] = list(reversed(d["frames"]))
    shuffled = LandmarkRequest.model_validate(d)
    a = compute_fingerprint(req, "m", "landmark-v1")
    assert a == compute_fingerprint(req, "m", "landmark-v1")
    assert a == compute_fingerprint(shuffled, "m", "landmark-v1")
    assert a.startswith("sha256:") and len(a) == 7 + 64


def test_fingerprint_ignores_request_id():
    assert compute_fingerprint(make_request(), "m", "v") == compute_fingerprint(make_request(requestId="req-2"), "m", "v")


@pytest.mark.parametrize(
    "change",
    [
        {"scanRevisionId": "revision-457"},
        {"routeSegmentId": "segment-790"},
        {"approachDirectionId": "approach-b"},
        {"maneuver": "right"},
        {"frames": 2},
        {"frameId": "frame-000139"},
        {"prompt": "landmark-v2"},
        {"model": "other-model"},
    ],
)
def test_fingerprint_changes_with_each_input(change):
    base = compute_fingerprint(make_request(), "m", "landmark-v1")
    model, prompt = change.pop("model", "m"), change.pop("prompt", "landmark-v1")
    maneuver = change.pop("maneuver", "left")
    frames = change.pop("frames", 3)
    d = request_dict(frames, maneuver, **change.copy() if "frameId" not in change else {})
    if "frameId" in change:
        d["frames"][0]["frameId"] = change["frameId"]
    other = compute_fingerprint(LandmarkRequest.model_validate(d), model, prompt)
    assert other != base


# ----------------------------------------------------------------- config ---


def test_config_from_env_defaults_and_overrides():
    cfg = GeminiConfig.from_env({"GEMINI_API_KEY": FAKE_KEY})
    assert cfg.max_retries == 2 and cfg.timeout_seconds == 90.0 and cfg.model == "gemini-3.6-flash"
    cfg = GeminiConfig.from_env({"GEMINI_API_KEY": FAKE_KEY, "GEMINI_MODEL": "x-flash",
                                 "GEMINI_TIMEOUT_SECONDS": "12.5", "GEMINI_MAX_RETRIES": "1"})
    assert (cfg.model, cfg.timeout_seconds, cfg.max_retries) == ("x-flash", 12.5, 1)


def test_config_requires_key():
    with pytest.raises(ConfigurationError):
        GeminiConfig.from_env({})


@pytest.mark.parametrize("env", [{"GEMINI_MAX_RETRIES": "9"}, {"GEMINI_MAX_RETRIES": "two"},
                                 {"GEMINI_TIMEOUT_SECONDS": "-1"}, {"GEMINI_MODEL": "  "}])
def test_config_rejects_bad_values(env):
    with pytest.raises(ConfigurationError) as e:
        GeminiConfig.from_env(dict({"GEMINI_API_KEY": FAKE_KEY}, **env))
    assert FAKE_KEY not in str(e.value)


def test_config_repr_hides_key():
    assert FAKE_KEY not in repr(GeminiConfig(api_key=FAKE_KEY))


def test_jpeg_fixture_is_accepted():
    assert JPEG.startswith(b"\xff\xd8\xff")
