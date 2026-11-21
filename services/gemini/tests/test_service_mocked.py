"""Service orchestration against a scripted fake provider (no network)."""

import logging

import pytest

from conftest import FAKE_KEY, assert_clean, candidate, make_request, make_service, response_json

from path_gemini import (
    PROMPT_VERSION,
    ConflictingDirectionError,
    CorruptImageError,
    ErrorCode,
    GeminiAuthenticationError,
    GeminiRateLimitedError,
    GeminiSafetyBlockError,
    GeminiTimeoutError,
    GeminiUnavailableError,
    InvalidModelOutputError,
    ProviderResponse,
    ResultCategory,
    UsageMetadata,
    compute_fingerprint,
)
from path_gemini.client import translate_exception


def test_successful_structured_response():
    usage = UsageMetadata(prompt_token_count=900, candidates_token_count=80, total_token_count=980)
    service, sleeps = make_service([ProviderResponse(text=response_json(), finish_reason="STOP", usage=usage,
                                                     model_version="test-model-001")])
    req = make_request()
    result = service.propose_landmarks(req)
    assert result.category is ResultCategory.CANDIDATES
    assert result.candidates[0].instruction == "Turn left after the purple mural."
    assert result.requires_review is True
    assert (result.model, result.prompt_version, result.attempts) == ("test-model", PROMPT_VERSION, 1)
    assert result.model_version == "test-model-001"
    assert result.usage.total_token_count == 980
    assert result.elapsed_ms > 0
    assert result.frame_ids == ["frame-000138", "frame-000142", "frame-000150"]
    assert result.fingerprint == compute_fingerprint(req, "test-model", PROMPT_VERSION)
    assert result.raw_response_text == response_json()
    assert sleeps == []
    assert service.client.models == ["test-model"]
    # Result serialization never carries bytes, and repr hides the raw text.
    assert_clean(result.model_dump_json(by_alias=True))
    assert "raw_response_text" not in repr(result)


def test_abstention_is_success_not_error():
    service, _ = make_service([response_json([], abstained=True, reason="Only plain walls are visible.")])
    result = service.propose_landmarks(make_request())
    assert result.category is ResultCategory.NO_CLEAR_LANDMARK
    assert result.abstained and result.candidates == []
    assert result.abstention_reason == "Only plain walls are visible."


@pytest.mark.parametrize("text", ["{not json", '{"candidates": []}', "", '{"candidates": [], "abstained": false, "abstentionReason": null}'])
def test_malformed_response_is_not_retried(text):
    service, sleeps = make_service([text, response_json()])
    with pytest.raises(InvalidModelOutputError) as e:
        service.propose_landmarks(make_request())
    assert service.client.calls == 1 and sleeps == []
    assert e.value.attempts == 1 and e.value.request_id == "req-1"


def test_rate_limit_then_success():
    service, sleeps = make_service([GeminiRateLimitedError(provider_status=429), response_json()])
    result = service.propose_landmarks(make_request())
    assert result.attempts == 2
    assert sleeps == [0.5]  # base 0.5s * 2^0 * (0.5 + 0.5 jitter)


def test_retry_exhaustion_uses_exponential_backoff():
    errors = [GeminiUnavailableError(provider_status=503) for _ in range(3)]
    service, sleeps = make_service(errors + [response_json()], max_retries=2)
    with pytest.raises(GeminiUnavailableError) as e:
        service.propose_landmarks(make_request())
    assert service.client.calls == 3 and e.value.attempts == 3
    assert sleeps == [0.5, 1.0]


def test_zero_retries_configured():
    service, sleeps = make_service([GeminiRateLimitedError(), response_json()], max_retries=0)
    with pytest.raises(GeminiRateLimitedError):
        service.propose_landmarks(make_request())
    assert service.client.calls == 1 and sleeps == []


def test_timeout_retried_then_fails():
    service, sleeps = make_service([GeminiTimeoutError()] * 3)
    with pytest.raises(GeminiTimeoutError) as e:
        service.propose_landmarks(make_request())
    assert e.value.code is ErrorCode.GEMINI_TIMEOUT and len(sleeps) == 2


def test_timeout_then_success():
    service, _ = make_service([GeminiTimeoutError(), response_json()])
    assert service.propose_landmarks(make_request()).attempts == 2


def test_authentication_failure_not_retried():
    service, sleeps = make_service([GeminiAuthenticationError(provider_status=401), response_json()])
    with pytest.raises(GeminiAuthenticationError):
        service.propose_landmarks(make_request())
    assert service.client.calls == 1 and sleeps == []


@pytest.mark.parametrize("reply", [ProviderResponse(text=None, block_reason="SAFETY"),
                                   ProviderResponse(text=None, finish_reason="SAFETY"),
                                   ProviderResponse(text="", finish_reason="PROHIBITED_CONTENT")])
def test_safety_refusal_not_retried(reply):
    service, sleeps = make_service([reply, response_json()])
    with pytest.raises(GeminiSafetyBlockError):
        service.propose_landmarks(make_request())
    assert service.client.calls == 1 and sleeps == []


def test_truncated_response_rejected():
    service, _ = make_service([ProviderResponse(text='{"candidates": [', finish_reason="MAX_TOKENS")])
    with pytest.raises(InvalidModelOutputError):
        service.propose_landmarks(make_request())


def test_conflicting_maneuver_rejected_after_valid_json():
    service, sleeps = make_service([response_json([candidate(instruction="Turn right at the purple mural.")])])
    with pytest.raises(ConflictingDirectionError):
        service.propose_landmarks(make_request(maneuver="left"))
    assert service.client.calls == 1 and sleeps == []


def test_unknown_frame_id_in_response_rejected():
    service, _ = make_service([response_json([candidate(frames=("frame-000138", "frame-424242"))])])
    with pytest.raises(InvalidModelOutputError):
        service.propose_landmarks(make_request())


def test_invalid_input_never_calls_provider():
    service, _ = make_service([response_json()])
    req = make_request()
    bad = req.model_copy(update={"frames": [req.frames[0].model_copy(update={"image_bytes": b"junk"}), *req.frames[1:]]})
    with pytest.raises(CorruptImageError):
        service.propose_landmarks(bad)
    assert service.client.calls == 0


def test_opposite_approach_is_a_separate_request():
    service, _ = make_service([response_json(), response_json()])
    a = service.propose_landmarks(make_request(approachDirectionId="approach-a"))
    b = service.propose_landmarks(make_request(approachDirectionId="approach-b"))
    assert a.fingerprint != b.fingerprint
    assert "approach-b" in service.client.prompts[1].parts[0].text


# --------------------------------------------------------------- telemetry ---


def _capture(caplog, script):
    log = logging.getLogger("path_gemini.test")
    service, _ = make_service(script, logger=log)
    caplog.set_level(logging.INFO, logger="path_gemini.test")
    return service


def test_success_telemetry_fields(caplog):
    service = _capture(caplog, [response_json()])
    service.propose_landmarks(make_request())
    rec = caplog.records[-1]
    fields = rec.path_gemini
    assert fields["result_category"] == "CANDIDATES"
    assert fields["model"] == "test-model" and fields["prompt_version"] == PROMPT_VERSION
    assert fields["frame_count"] == 3 and fields["retry_count"] == 0 and fields["elapsed_ms"] >= 0
    assert set(fields) == {"request_id", "scan_revision_id", "route_segment_id", "approach_direction_id",
                           "frame_count", "model", "prompt_version", "elapsed_ms", "attempts", "retry_count",
                           "result_category", "error_category", "provider_status", "candidate_count"}


def test_failure_telemetry_and_errors_contain_no_secrets(caplog):
    service = _capture(caplog, [GeminiRateLimitedError(provider_status=429)] * 3)
    with pytest.raises(GeminiRateLimitedError) as e:
        service.propose_landmarks(make_request())
    rec = caplog.records[-1]
    assert rec.levelno == logging.WARNING
    assert rec.path_gemini["error_category"] == "GEMINI_RATE_LIMITED"
    assert rec.path_gemini["retry_count"] == 2
    log_text = caplog.text + repr([r.__dict__ for r in caplog.records])
    assert_clean(log_text)
    assert_clean(str(e.value) + repr(e.value) + repr(e.value.to_dict()))
    assert "Turn left" not in log_text  # no prompt text in logs
    assert FAKE_KEY not in repr(service) + repr(service.config)


def test_invalid_output_log_has_no_model_prose(caplog):
    bad = response_json([candidate(instruction="Turn right toward SECRET-ROOM-NAME.")])
    service = _capture(caplog, [bad])
    with pytest.raises(ConflictingDirectionError) as e:
        service.propose_landmarks(make_request())
    assert "SECRET-ROOM-NAME" not in caplog.text and "SECRET-ROOM-NAME" not in str(e.value)


# ---------------------------------------------------- provider error mapping ---


class _FakeAPIError(Exception):
    def __init__(self, code, status="", details=None):
        super().__init__("provider said: key=" + FAKE_KEY + " body=iVBORw0KGgo")
        self.code, self.status, self.details, self.message = code, status, details, "raw provider text"


@pytest.mark.parametrize(
    "exc,expected,retryable",
    [
        (_FakeAPIError(401, "UNAUTHENTICATED"), GeminiAuthenticationError, False),
        (_FakeAPIError(403, "PERMISSION_DENIED"), GeminiAuthenticationError, False),
        (_FakeAPIError(400, "INVALID_ARGUMENT", {"error": {"details": [{"reason": "API_KEY_INVALID"}]}}),
         GeminiAuthenticationError, False),
        (_FakeAPIError(429, "RESOURCE_EXHAUSTED"), GeminiRateLimitedError, True),
        (_FakeAPIError(500, "INTERNAL"), GeminiUnavailableError, True),
        (_FakeAPIError(503, "UNAVAILABLE"), GeminiUnavailableError, True),
        (_FakeAPIError(504, "DEADLINE_EXCEEDED"), GeminiTimeoutError, True),
        (_FakeAPIError(404, "NOT_FOUND"), GeminiUnavailableError, False),
        (TimeoutError("read timed out"), GeminiTimeoutError, True),
        (ConnectionError("reset"), GeminiUnavailableError, True),
        (RuntimeError("weird " + FAKE_KEY), GeminiUnavailableError, False),
    ],
)
def test_translate_exception(exc, expected, retryable):
    err = translate_exception(exc)
    assert isinstance(err, expected) and err.retryable is retryable
    assert_clean(str(err) + repr(err.to_dict()))
    assert "raw provider text" not in str(err)


def test_httpx_style_timeout_maps_to_timeout():
    ReadTimeout = type("ReadTimeout", (Exception,), {})
    ConnectError = type("ConnectError", (Exception,), {})
    assert isinstance(translate_exception(ReadTimeout()), GeminiTimeoutError)
    assert isinstance(translate_exception(ConnectError()), GeminiUnavailableError)


# ------------------------------------------- google-genai adapter (no network) ---


def test_google_adapter_builds_one_structured_multimodal_request():
    from google.genai import types

    from path_gemini import GoogleGenAIClient
    from path_gemini.prompt import build_prompt
    from path_gemini.validation import validate_request

    client = GoogleGenAIClient(FAKE_KEY, timeout_seconds=12)
    captured = {}

    def fake_generate_content(*, model, contents, config):
        captured.update(model=model, contents=contents, config=config)
        return types.GenerateContentResponse(
            candidates=[types.Candidate(
                content=types.Content(role="model", parts=[types.Part.from_text(text=response_json())]),
                finish_reason=types.FinishReason.STOP)],
            usage_metadata=types.GenerateContentResponseUsageMetadata(prompt_token_count=10, total_token_count=12),
            model_version="sdk-model-1",
        )

    client._client.models.generate_content = fake_generate_content
    req = make_request()
    prompt = build_prompt(req, validate_request(req, 10_000_000))
    reply = client.generate(prompt, model="cfg-model")

    assert captured["model"] == "cfg-model"
    cfg = captured["config"]
    assert cfg.response_mime_type == "application/json"
    assert cfg.response_json_schema == prompt.response_schema
    assert not cfg.tools
    assert cfg.automatic_function_calling.disable is True
    parts = captured["contents"][0].parts
    kinds = ["image" if p.inline_data else "text" for p in parts]
    assert kinds == ["text", "text", "image", "text", "image", "text", "image", "text"]
    assert parts[1].text.startswith("Image 1 of 3: frameId=frame-000138 role=approach")
    assert parts[2].inline_data.mime_type == "image/png"
    assert reply.text == response_json() and reply.finish_reason == "STOP"
    assert reply.usage.total_token_count == 12 and reply.model_version == "sdk-model-1"
    assert FAKE_KEY not in repr(client)


def test_google_adapter_translates_sdk_errors():
    from google.genai import errors as genai_errors

    from path_gemini import GoogleGenAIClient
    from path_gemini.prompt import build_prompt
    from path_gemini.validation import validate_request

    client = GoogleGenAIClient(FAKE_KEY, timeout_seconds=5)

    def boom(**_):
        raise genai_errors.ClientError(429, {"error": {"code": 429, "message": "quota " + FAKE_KEY,
                                                       "status": "RESOURCE_EXHAUSTED"}})

    client._client.models.generate_content = boom
    req = make_request()
    with pytest.raises(GeminiRateLimitedError) as e:
        client.generate(build_prompt(req, validate_request(req, 10_000_000)), model="m")
    assert e.value.__cause__ is None and e.value.__suppress_context__
    assert_clean(str(e.value))
