from conftest import make_request, request_dict

from path_gemini import PROMPT_VERSION
from path_gemini.prompt import MANEUVER_PHRASES, SYSTEM_INSTRUCTION, build_prompt, response_schema
from path_gemini.models import Maneuver
from path_gemini.validation import ordered_frames, validate_request


def _prompt(**kw):
    req = make_request(**kw)
    return build_prompt(req, validate_request(req, 10_000_000))


def test_prompt_version_constant():
    assert PROMPT_VERSION == "landmark-v2"
    assert _prompt().version == "landmark-v2"


def test_frames_ordered_approach_junction_exit_regardless_of_input_order():
    req = make_request()
    frames = request_dict()["frames"]
    shuffled = make_request(frames=[frames[2], frames[0], frames[1]])
    assert [f.role.value for f in ordered_frames(shuffled)] == ["approach", "junction", "exit"]
    a = build_prompt(req, ordered_frames(req))
    b = build_prompt(shuffled, ordered_frames(shuffled))
    assert [(p.kind, p.text, p.frame_id) for p in a.parts] == [(p.kind, p.text, p.frame_id) for p in b.parts]


def test_each_image_is_immediately_preceded_by_its_label():
    parts = _prompt().parts
    images = [i for i, p in enumerate(parts) if p.kind == "image"]
    assert len(images) == 3
    for i in images:
        label = parts[i - 1]
        assert label.kind == "text"
        assert "frameId=" + parts[i].frame_id in label.text
    roles = [parts[i - 1].text.split("role=")[1].split()[0] for i in images]
    assert roles == ["approach", "junction", "exit"]


def test_prompt_includes_maneuver_waypoints_and_phrase():
    text = "\n".join(p.text for p in _prompt(maneuver="right").parts if p.kind == "text")
    assert "Verified maneuver: right" in text
    assert MANEUVER_PHRASES[Maneuver.RIGHT] in text
    assert "wp-16 -> junction wp-17 -> exit wp-18" in text
    assert "approach-a" in text


def test_prompt_is_deterministic():
    a, b = _prompt(), _prompt()
    assert [(p.kind, p.text, p.mime_type, p.data) for p in a.parts] == [(p.kind, p.text, p.mime_type, p.data) for p in b.parts]
    assert a.response_schema == b.response_schema


def test_two_frame_prompt():
    parts = _prompt(frame_count=2).parts
    assert sum(1 for p in parts if p.kind == "image") == 2
    assert "Image 2 of 2" in "\n".join(p.text or "" for p in parts)


def test_system_instruction_covers_required_rules():
    s = SYSTEM_INSTRUCTION.lower()
    for phrase in ["do not calculate", "verified and final", "only evidence", "do not invent",
                   "temporary or movable", "blurry", "untrusted scene content", "only frame ids supplied",
                   "empty candidates list", "private or identifying"]:
        assert phrase in s, phrase


def test_schema_limits_candidates_and_frame_ids():
    schema = response_schema(["a", "b"])
    cands = schema["properties"]["candidates"]
    assert cands["maxItems"] == 3
    assert cands["items"]["properties"]["sourceFrameIds"]["items"]["enum"] == ["a", "b"]
    assert "confidence" not in str(schema).lower()


def test_prompt_repr_hides_bytes():
    r = repr(_prompt())
    assert "PNG" not in r and "SECRET" not in r and "Turn" not in r
