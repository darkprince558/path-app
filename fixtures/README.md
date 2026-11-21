# Venue integration fixture

[Open the manifest](venue/manifest.json) to see the complete v1 example. The 93 colored points in [scene.ply](venue/scene.ply) depict a synthetic T-shaped corridor. From the green entrance, walk 4 m to the junction. Both destinations are 3 m from there. The workshop is on the left under an amber doorway and the info booth is on the right under a purple doorway.

## Manifest v1

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `eventId` | Integer `1` and a stable event identifier. |
| `scene.format`, `scene.path` | `ply` and a path relative to the manifest. Resolve the path against the manifest URL when loading it in a browser. |
| `waypoints[]` | Each waypoint has a unique `id` and a three-number `position` in meters. |
| `edges[]` | Each edge connects the waypoint IDs `from` and `to` in both directions. Its weight is the Euclidean distance between their positions. |
| `startWaypointId` | The waypoint associated with the demo entrance QR code. |
| `destinations[]` | Each destination has a unique `id`, a guest-facing `label`, and a `waypointId` reachable from the start. |

The graph and PLY vertices share a right-handed event frame. The demo entrance is the origin, +X is right, +Y is up and −Z is forward from the entrance. The capture exporter aligns the scan to the event frame before handing it to the viewer. Use a point renderer for the PLY. It contains XYZ positions and unsigned 8-bit RGB colors.

## Check a fixture

From the repo root, run either command with Python 3.

```sh
python3 scripts/check_fixture.py
python3 scripts/check_fixture.py path/to/another/manifest.json
```

The validator checks the manifest structure, finite waypoint coordinates, unique IDs, edge endpoints, and reachability from the marked start to every destination. It checks that the referenced scene file exists within the manifest directory. Open the scene in the viewer to check its colors, scale, and alignment.
