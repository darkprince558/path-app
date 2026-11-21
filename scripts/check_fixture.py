#!/usr/bin/env python3
"""Validate a Path App v1 integration manifest and its scene reference."""

import argparse
import json
import math
import re
from pathlib import Path


DEFAULT_MANIFEST = Path(__file__).resolve().parents[1] / "fixtures/venue/manifest.json"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text_field(record, key):
    value = record.get(key)
    require(isinstance(value, str) and value.strip(), f"Expected nonempty string for {key}")
    return value


def records(manifest, key):
    rows = manifest.get(key)
    require(isinstance(rows, list), f"Expected an array for {key}")
    require(all(isinstance(row, dict) for row in rows), f"Expected objects in {key}")
    return rows


def index_by_id(manifest, key):
    result = {}
    for row in records(manifest, key):
        identifier = text_field(row, "id")
        require(identifier not in result, f"Duplicate ID in {key}: {identifier}")
        result[identifier] = row
    return result


def check_scene(manifest, directory):
    scene = manifest.get("scene")
    require(isinstance(scene, dict) and scene.get("format") == "ply", "Expected a PLY scene")
    path = text_field(scene, "path")
    segments = path.split("/")
    require(all(re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", part) for part in segments),
            "Expected a relative scene path made of URL-safe filenames")
    asset = (directory / path).resolve()
    require(directory in asset.parents, "Scene path escapes the manifest directory")
    require(asset.is_file(), f"Missing scene asset: {path}")


def validate(manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(isinstance(manifest, dict), "Expected a manifest object")
    version = manifest.get("schemaVersion")
    require(type(version) is int and version == 1, "Expected integer schemaVersion 1")
    text_field(manifest, "eventId")
    check_scene(manifest, manifest_path.parent.resolve())

    waypoints = index_by_id(manifest, "waypoints")
    for waypoint_id, row in waypoints.items():
        point = row.get("position")
        require(isinstance(point, list) and len(point) == 3, f"Expected XYZ for {waypoint_id}")
        require(all(type(v) in (float, int) and math.isfinite(v) for v in point),
                f"Expected finite coordinates for {waypoint_id}")

    start = text_field(manifest, "startWaypointId")
    require(start in waypoints, f"Unknown starting waypoint: {start}")
    neighbors = {waypoint_id: set() for waypoint_id in waypoints}
    for edge in records(manifest, "edges"):
        a, b = text_field(edge, "from"), text_field(edge, "to")
        require(a in waypoints and b in waypoints, f"Unknown waypoint on edge {a} to {b}")
        require(a != b and b not in neighbors[a], f"Self-loop or duplicate edge: {a} to {b}")
        neighbors[a].add(b)
        neighbors[b].add(a)

    reachable = {start}
    pending = [start]
    while pending:
        additions = neighbors[pending.pop()] - reachable
        reachable.update(additions)
        pending.extend(additions)

    destinations = index_by_id(manifest, "destinations")
    require(destinations, "Expected at least one destination")
    for destination_id, row in destinations.items():
        text_field(row, "label")
        waypoint_id = text_field(row, "waypointId")
        require(waypoint_id in waypoints, f"Unknown waypoint for {destination_id}: {waypoint_id}")
        require(waypoint_id in reachable, f"Destination unreachable from {start}: {destination_id}")
    return len(waypoints), len(destinations)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, nargs="?", default=DEFAULT_MANIFEST)
    args = parser.parse_args()
    try:
        waypoints, destinations = validate(args.manifest)
    except (OSError, ValueError, OverflowError, RuntimeError) as error:
        parser.exit(1, f"Invalid fixture: {error}\n")
    print(f"Valid fixture: {waypoints} waypoints, {destinations} reachable destinations")


if __name__ == "__main__":
    main()
