"""Turn detection from path corners (shared cases + edge cases)."""

import json
import math

import pytest

from conftest import PACKAGE_DIR

from path_gemini.models import Maneuver
from path_gemini.turns import PathError, classify, match_cue, path_turns, signed_turn_degrees

CASES = json.loads((PACKAGE_DIR / "fixtures" / "turn_cases.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_turn_cases(case):
    turns = path_turns(case["points"])
    got = [[t.maneuver.value, t.side, t.index, round(t.distance_from_start, 2)] for t in turns]
    assert got == case["expect"]


def test_left_is_positive_with_y_up():
    facing_minus_z = (0.0, -1.0)
    assert signed_turn_degrees(facing_minus_z, (-1.0, 0.0)) == pytest.approx(90)  # toward -X: left
    assert signed_turn_degrees(facing_minus_z, (1.0, 0.0)) == pytest.approx(-90)  # toward +X: right
    # Same rule when facing +X: left is toward -Z.
    assert signed_turn_degrees((1.0, 0.0), (0.0, -1.0)) == pytest.approx(90)


@pytest.mark.parametrize("angle,expected", [
    (0, Maneuver.STRAIGHT), (19.9, Maneuver.STRAIGHT), (20, Maneuver.SLIGHT_LEFT), (-44.9, Maneuver.SLIGHT_RIGHT),
    (45, Maneuver.LEFT), (-150, Maneuver.RIGHT), (150.1, Maneuver.U_TURN), (-179, Maneuver.U_TURN),
])
def test_angle_thresholds(angle, expected):
    assert classify(angle) is expected


def test_opposite_direction_mirrors_the_turn():
    there = path_turns([[0, 0, 0], [0, 0, -4], [-3, 0, -4]])
    back = path_turns([[-3, 0, -4], [0, 0, -4], [0, 0, 0]])
    assert there[0].maneuver is Maneuver.LEFT and back[0].maneuver is Maneuver.RIGHT


def test_way_one_and_way_two_shapes():
    """Way 1: hallway, turn left, stairs down. Way 2: come up the stairs, turn right."""
    way1 = path_turns([[0, 0, 0], [0, 0, -8], [-3, -1.8, -8]])
    assert way1[0].instruction == "Turn left and take the stairs down"
    way2 = path_turns([[-3, -1.8, -8], [0, 0, -8], [0, 0, 0]])
    assert way2[0].maneuver is Maneuver.RIGHT and way2[0].instruction == "Turn right"


def test_mid_staircase_landing_is_not_announced():
    pts = [[0, 0, 0], [0, 0, -4], [0, -1.5, -7], [-1, -1.5, -7.5], [-1, -3, -10.5], [-1, -3, -12]]
    names = [t.maneuver.value for t in path_turns(pts)]
    assert names.count("stairs_down") == 1


def test_include_straight_option():
    pts = [[0, 0, 0], [0, 0, -4], [-0.5, 0, -8]]  # about 7 degrees
    assert [t.maneuver.value for t in path_turns(pts)] == ["arrive"]
    assert [t.maneuver.value for t in path_turns(pts, include_straight=True, simplify_tolerance=0.1)] == [
        "straight", "arrive"]


def test_to_dict_shape():
    d = path_turns([[0, 0, 0], [0, 0, -4], [-3, 0, -4]])[0].to_dict()
    assert d["maneuver"] == "left" and d["position"] == {"x": 0.0, "y": 0.0, "z": -4.0}
    assert d["incomingHeading"] == {"x": 0.0, "z": -1.0} and d["outgoingHeading"] == {"x": -1.0, "z": 0.0}
    assert d["instruction"] == "Turn left" and d["angleDegrees"] == 90.0


@pytest.mark.parametrize("points", [
    [], [[0, 0, 0]], [[0, 0, 0], [0, 0, 0]], [[0, 0, 0], [0, 3, 0]],
    [[0, 0, 0], [math.inf, 0, 1]], [[0, 0, 0], ["a", 0, 1]], [{"x": 0, "y": 0}, {"x": 1, "y": 0, "z": 0}],
])
def test_bad_paths_rejected(points):
    with pytest.raises(PathError):
        path_turns(points)


def test_accepts_navmesh_point_objects():
    pts = [{"x": 0, "y": 0, "z": 0}, {"x": 0, "y": 0, "z": -4}, {"x": -3, "y": 0, "z": -4}]
    assert path_turns(pts)[0].maneuver is Maneuver.LEFT


def test_too_many_points_rejected():
    with pytest.raises(PathError):
        path_turns([[0, 0, -i * 0.01] for i in range(3000)])


# --------------------------------------------------------------- cue matching ---


def _cue(**kw):
    cue = {"maneuver": "left", "position": {"x": 0.3, "y": 0, "z": -4.2}, "incomingHeading": {"x": 0, "z": -1},
           "approvedText": "Turn left at the black door."}
    cue.update(kw)
    return cue


def test_cue_matches_same_turn_and_direction():
    turn = path_turns([[0, 0, 0], [0, 0, -4], [-3, 0, -4]])[0]
    assert match_cue(turn, [_cue()])["approvedText"] == "Turn left at the black door."


def test_cue_not_reused_from_opposite_direction_or_far_away():
    turn = path_turns([[0, 0, 0], [0, 0, -4], [-3, 0, -4]])[0]
    assert match_cue(turn, [_cue(incomingHeading={"x": 0, "z": 1})]) is None  # walking the other way
    assert match_cue(turn, [_cue(position={"x": 5, "y": 0, "z": -4})]) is None  # 5 m away
    assert match_cue(turn, [_cue(maneuver="right")]) is None
    assert match_cue(turn, [{"maneuver": "left"}]) is None  # malformed cue is skipped


def test_nearest_cue_wins_and_stairs_side_must_match():
    turn = path_turns([[0, 0, 0], [0, 0, -4], [-3, 0, -4]])[0]
    near, far = _cue(approvedText="near"), _cue(position={"x": 1.5, "y": 0, "z": -4}, approvedText="far")
    assert match_cue(turn, [far, near])["approvedText"] == "near"
    stairs = path_turns([[0, 0, 0], [0, 0, -8], [-3, -1.8, -8]])[0]
    wrong_side = _cue(maneuver="stairs_down", side="right", position={"x": 0, "y": 0, "z": -8})
    right_side = _cue(maneuver="stairs_down", side="left", position={"x": 0, "y": 0, "z": -8}, approvedText="ok")
    assert match_cue(stairs, [wrong_side]) is None and match_cue(stairs, [wrong_side, right_side])["approvedText"] == "ok"
