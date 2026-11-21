"""Post-response validation of model output."""

import json

import pytest

from conftest import candidate, make_request, response_json

from path_gemini import ConflictingDirectionError, InvalidModelOutputError
from path_gemini.validation import (
    check_instruction_maneuver,
    detect_maneuver_families,
    parse_model_output,
    validate_model_output,
)
from path_gemini.models import Maneuver


def _check(text, maneuver="left"):
    return validate_model_output(parse_model_output(text), make_request(maneuver=maneuver))


def test_valid_candidate_response():
    out = _check(response_json())
    assert out.candidates[0].source_frame_ids == ["frame-000138", "frame-000142"]
    assert out.abstained is False


def test_three_candidates_ok():
    out = _check(response_json([candidate(), candidate(landmark="red sign"), candidate(landmark="bench")]))
    assert len(out.candidates) == 3


def test_valid_abstention():
    out = _check(response_json([], abstained=True, reason="No distinctive landmark is consistently visible."))
    assert out.abstained and out.candidates == []


def test_unknown_frame_id_rejected():
    with pytest.raises(InvalidModelOutputError) as e:
        _check(response_json([candidate(frames=("frame-000138", "frame-999999"))]))
    assert "unknown frame" in str(e.value)
    assert "frame-999999" not in str(e.value)


def test_more_than_three_candidates_rejected():
    with pytest.raises(InvalidModelOutputError):
        _check(response_json([candidate()] * 4))


@pytest.mark.parametrize("field", ["landmark", "instruction"])
@pytest.mark.parametrize("value", ["", "   "])
def test_empty_landmark_or_instruction(field, value):
    with pytest.raises(InvalidModelOutputError):
        _check(response_json([candidate(**{field: value})]))


def test_instruction_too_long():
    long = "Turn left after the " + "very " * 30 + "purple mural."
    with pytest.raises(InvalidModelOutputError):
        _check(response_json([candidate(instruction=long)]))


@pytest.mark.parametrize(
    "instruction",
    [
        "Turn right at the purple mural.",
        "Turn left, then turn right at the mural.",
        "Continue straight past the purple mural.",
        "Bear left at the purple mural.",
        "Make a U-turn at the purple mural.",
    ],
)
def test_conflicting_direction_rejected(instruction):
    with pytest.raises(ConflictingDirectionError):
        _check(response_json([candidate(instruction=instruction)]))


def test_one_conflicting_candidate_rejects_whole_response():
    with pytest.raises(ConflictingDirectionError):
        _check(response_json([candidate(), candidate(instruction="Turn right after the bench.")]))


def test_instruction_missing_maneuver_rejected():
    with pytest.raises(InvalidModelOutputError):
        _check(response_json([candidate(instruction="Look for the purple mural.")]))


@pytest.mark.parametrize(
    "maneuver,instruction",
    [
        ("right", "Turn right at the blue vending machine."),
        ("straight", "Continue straight past the blue vending machine."),
        ("slight_left", "Bear left at the blue vending machine."),
        ("slight_right", "Keep to the right after the blue vending machine."),
        ("u_turn", "Turn around at the blue vending machine."),
        ("arrive", "Arrive at the door beside the blue vending machine on your left."),
    ],
)
def test_allowed_phrasings_per_maneuver(maneuver, instruction):
    check_instruction_maneuver(instruction, Maneuver(maneuver))


def test_slight_left_is_not_plain_left():
    assert detect_maneuver_families("Bear left at the mural") == {"slight_left"}
    with pytest.raises(ConflictingDirectionError):
        check_instruction_maneuver("Turn left at the mural", Maneuver.SLIGHT_LEFT)


@pytest.mark.parametrize(
    "payload",
    [
        {"candidates": [], "abstained": True, "abstentionReason": None},
        {"candidates": [], "abstained": True, "abstentionReason": "  "},
        {"candidates": [candidate()], "abstained": True, "abstentionReason": "unclear"},
        {"candidates": [], "abstained": False, "abstentionReason": None},
        {"candidates": [candidate()], "abstained": False, "abstentionReason": "but also abstaining"},
    ],
)
def test_inconsistent_abstention_rejected(payload):
    with pytest.raises(InvalidModelOutputError):
        _check(json.dumps(payload))


@pytest.mark.parametrize(
    "overrides",
    [
        {"instruction": "Turn left at the mural, see https://example.com/map"},
        {"landmark": "<b>purple mural</b>"},
        {"instruction": "Turn left at waypoint wp-17."},
        {"instruction": "Turn left as shown in frame-000142."},
        {"landmark": "mural ![img](http://x/y.png)"},
        {"visibleText": "   "},
        {"visibleText": "A" * 61},
        {"reason": "see www.example.com"},
        {"sourceFrameIds": []},
        {"sourceFrameIds": ["frame-000138", "frame-000138"]},
    ],
)
def test_unsafe_or_malformed_candidate_fields(overrides):
    with pytest.raises(InvalidModelOutputError):
        _check(response_json([candidate(**overrides)]))


def test_visible_text_short_is_ok():
    out = _check(response_json([candidate(visibleText="ROOM 214")]))
    assert out.candidates[0].visible_text == "ROOM 214"


@pytest.mark.parametrize(
    "text",
    ["", "not json", "[]", '{"candidates": "nope", "abstained": false, "abstentionReason": null}',
     '{"candidates": [], "abstained": true}',
     json.dumps({"candidates": [dict(candidate(), confidence=0.9)], "abstained": False, "abstentionReason": None}),
     json.dumps({"candidates": [dict(candidate(), visibility="certain")], "abstained": False, "abstentionReason": None})],
)
def test_malformed_or_schema_invalid(text):
    with pytest.raises(InvalidModelOutputError) as e:
        _check(text)
    assert "certain" not in str(e.value) and "nope" not in str(e.value)
