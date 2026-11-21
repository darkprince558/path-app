"""Choosing approach/junction/exit photos from camera poses."""

import pytest

from path_gemini.photo_select import FrameSelectError, parse_frames, select_frames
from path_gemini.turns import path_turns


def pose(x, y, z, fx, fz):
    """Column-major camera-to-world with the camera looking along (fx, 0, fz)."""
    return [1, 0, 0, 0, 0, 1, 0, 0, -fx, 0, -fz, 0, x, y, z, 1]


def walk_left_turn(back_facing=False):
    """Walk 8 m along -Z (one photo per metre), turn left at z=-8, walk 5 m along -X."""
    frames = []
    for i in range(9):
        frames.append({"frameId": "a{}".format(i), "cameraToWorld": pose(0, 1.5, -i, 0, -1),
                       "timestampSeconds": float(i), "trackingState": "normal"})
    for j in range(1, 6):
        frames.append({"frameId": "b{}".format(j), "cameraToWorld": pose(-j, 1.5, -8, -1, 0),
                       "timestampSeconds": 8.0 + j, "trackingState": "normal"})
    if back_facing:  # someone walking the other way down the same hallway
        for i in range(9):
            frames.append({"frameId": "r{}".format(i), "cameraToWorld": pose(0.2, 1.5, -i, 0, 1),
                           "trackingState": "normal"})
    return frames


TURN = path_turns([[0, 0, 0], [0, 0, -8], [-5, 0, -8]])[0].to_dict()


def test_picks_photo_before_at_and_after_the_turn():
    pick = select_frames(TURN, walk_left_turn())
    assert (pick["approach"], pick["junction"], pick["exit"]) == ("a3", "a7", "b2")
    assert pick["usable"] is True and pick["consideredFrames"] == 14


def test_ignores_photos_facing_the_other_way():
    pick = select_frames(TURN, walk_left_turn(back_facing=True))
    assert not any(str(pick[r]).startswith("r") for r in ("approach", "junction", "exit"))


def test_opposite_walk_uses_opposite_photos():
    frames = walk_left_turn(back_facing=True)
    back_turn = path_turns([[0, 0, -8], [0, 0, 0], [3, 0, 0]])  # walking +Z, then toward +X
    assert back_turn[0].maneuver.value == "left"  # facing +Z, +X is on your left
    pick = select_frames(back_turn[0].to_dict(), frames)
    assert pick["junction"] is None or pick["junction"].startswith("r")


def test_poor_tracking_and_missing_poses_are_skipped():
    frames = walk_left_turn()
    for f in frames:
        if f["frameId"] == "a7":
            f["trackingState"] = "limited"
    frames.append({"frameId": "nopose"})
    pick = select_frames(TURN, frames)
    assert pick["junction"] != "a7" and pick["junction"] in ("a6", "a8")


def test_sam_backend_spelling_and_capture_to_space_transform():
    # Sam's frames.json v1 uses "id" and "cameraPose"; poses here are 10 m off along +X.
    frames = [{"id": f["frameId"], "cameraPose": pose(*(lambda m: (m[12] + 10, m[13], m[14]))(f["cameraToWorld"]),
                                                      *(lambda m: (-m[8], -m[10]))(f["cameraToWorld"]))}
              for f in walk_left_turn()]
    shift_back = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -10, 0, 0, 1]
    assert select_frames(TURN, frames)["usable"] is False  # wrong frame: nothing lines up
    pick = select_frames(TURN, frames, capture_to_space=shift_back)
    assert (pick["approach"], pick["junction"], pick["exit"]) == ("a3", "a7", "b2")


def test_only_one_role_found_is_not_usable():
    frames = [f for f in walk_left_turn() if f["frameId"] in ("a7",)]
    pick = select_frames(TURN, frames)
    assert pick["junction"] == "a7" and pick["usable"] is False


def test_stairs_exit_may_be_on_another_floor():
    stairs_turn = path_turns([[0, 0, 0], [0, 0, -8], [-3, -1.8, -8]])[0].to_dict()
    frames = walk_left_turn()
    # Held at eye height, 1.8 m below the hallway floor, partway down the stairs.
    frames.append({"frameId": "down", "cameraToWorld": pose(-2, -0.4, -8, -1, 0)})
    for f in frames:
        if f["frameId"].startswith("b"):
            f["trackingState"] = "limited"
    pick = select_frames(stairs_turn, frames)
    assert pick["exit"] == "down"
    assert select_frames(TURN, frames)["exit"] is None  # a flat turn must not use a lower floor photo


@pytest.mark.parametrize("turn", [None, {}, {"position": {"x": 0, "y": 0}, "incomingHeading": {"x": 0, "z": -1}},
                                  {"position": [0, 0, 0], "incomingHeading": {"x": 0, "z": 0}}])
def test_bad_turn_rejected(turn):
    with pytest.raises(FrameSelectError):
        select_frames(turn, walk_left_turn())


def test_bad_frames_rejected():
    with pytest.raises(FrameSelectError):
        parse_frames([{"cameraToWorld": pose(0, 0, 0, 0, -1)}])  # no id
    with pytest.raises(FrameSelectError):
        parse_frames([{"id": "x", "cameraPose": [1, 2, 3]}])
    with pytest.raises(FrameSelectError):
        parse_frames([], capture_to_space=[1] * 15)


def test_camera_looking_at_floor_is_skipped():
    looking_down = {"id": "floor", "cameraPose": [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 1.5, -7, 1]}
    assert parse_frames([looking_down]) == []
