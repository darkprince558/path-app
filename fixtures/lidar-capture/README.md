# Synthetic LiDAR ingestion bundle

Entirely synthetic; verifies ingestion, integrity and stable frame references,
not physical capture, alignment or walkability.

- `source.glb` copies the existing 432-byte triangle fixture.
- `points.ply` contains three declared metric points.
- The two JPEGs are generated 8×8 solid colors.
- `frames.json` supplies one stable frame with an identity camera pose.
- `manifest.json` records exact sizes and SHA-256 for all other bundle files.

The manifest excludes itself from its inventory. Registration stores a normalized
copy. Follow the [API contract](../../docs/capture-api.md) to upload/finalize it.
The API tests verify committed hashes, sizes and references stay in sync.
