# Capture and processing

The isolated [LiDAR contract integration](../../docs/lidar-contract-compatibility.md)
adapts the native exporter and [CPU processor](processor/README.md) to the existing
backend contract. Its shared synthetic fixture is `fixtures/lidar-native-capture/`.

Krishna and Anish own the phone capture, export and alignment pipeline. Start by scanning a short corridor with an identifiable turn. Try exporting colored PLY from a LiDAR phone and give Arielle and Sam the resulting format, file size, encoding, axis convention and a known distance. Keep local captures in the ignored `captures-local/` directory at the repository root.

Save several camera frames while recording and label which turn or landmark they show. These are the inputs for Gemini’s directions experiment. For the venue milestone, verify scan-to-event alignment before exporting the routing graph in meters.

[First phone trial and format alternatives](../../docs/scan-formats.md) · [Shared venue example](../../fixtures/README.md)
