# Shared native capture contract fixture

Synthetic only. Geometry, binary XYZ/RGB PLY and two 64×64 generated JPEGs come
from Anish's Swift writer fixture in PR #32 (`61aae46`). The version 1 JSON
envelope is updated to match the backend Zod contract. This is a 2 m vertical
wall (200 triangles) and 121 points, not a walkable room or physical scan.

Device/take ID: `6d8c1359-2480-4493-89b8-39be20cc6fc9`, matching the saved take
in `apps/capture/native-tests/main.swift`. Frame IDs remain `frame-0000` and
`frame-0007`; times are 0.25 s and 1.25 s. Poses are unchanged; the second pose
is translated 0.2 m in X. Intrinsics are fx=fy=48, cx=cy=32 at saved 64×64
resolution. The Swift fixture exercises scaling from a 128×128 calibration.

All payload sizes and SHA-256 checksums were recomputed after changing
`frames.json`. `manifest.json` excludes itself. The backend canonicalizes the
manifest when storing it; do not compare its pretty-printed file digest to the
backend manifest identity.

This directory deliberately leaves `fixtures/lidar-capture/` unchanged. Run the
[compatibility checks](../docs/lidar-contract-compatibility.md). On macOS,
`bash scripts/check-lidar-contract-export.sh` generates a fresh bundle using the
actual adapted Swift writer, then validates it with backend Zod and the CPU CLI.
Generated Swift JSON/JPEG serialization need not match this fixture byte-for-byte;
each bundle must pass its own inventory checks and retain the same identities,
poses, dimensions and calibrated scale. No Swift execution is claimed on Linux.
