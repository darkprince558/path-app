# What the Mac field runs changed

Keep normal walking pace in the next capture trial. On a 57-second phone recording, the default 160-keyframe budget sampled about 2.8 frames per second. The largest verified map selected for export covered only the first 19 seconds. Processing the same source at six keyframes per second with global mapping produced one model with all 343 sampled poses. The original tracking and dense reconstruction code is on the [Mac capture branch](https://github.com/darkprince558/path-app/pull/19).

Anish and Krishna can reproduce the camera comparison on a new recording with the two commands below. Choose fresh local run folders. Compare sampled camera coverage, the intervals that dropped out and the shape of the camera path through the turn.

```sh
./hallway3d "$VIDEO" --surface mesh --output captures-local/default-rate --no-preview
./hallway3d "$VIDEO" --surface mesh --mapping global --fps 6 --max-frames 344 --output captures-local/six-fps --no-preview
```

All 343 registered poses still left a questionable section. After aligning the lower-rate submap to the denser reconstruction over the same five-second stretch, the camera positions disagreed by 36% of local trajectory extent on alternating check poses. The median direction difference was about a quarter of a degree. The comparison used the same footage twice. An independent view or a measured doorway is still needed to judge which geometry was closer.

A separate 20-second clip registered all 160 sampled views. The experimental fixed-pose Mac run recovered 528 LIMAP tracks. Of those, 305 aligned with image edges in two or more RGB views reserved from line fitting. The plane pass moved rendered coverage from 58.79% to 59.63% in seven reserved camera views around a turn. The line-and-depth boundary check removed zero additional triangles there. This experiment verified local line reconstruction and supplied no measured doorway-width improvement.

For the next field trial, keep the source video, rate, frame cap and missing intervals together. Compare repeated views of a doorway against its measured width, and reserve a complete building for the final settings. The capture owner has the local per-run evidence under `captures-local/runs/field-trial-01/`, including a `trajectory-check.json` in the denser run folder. The [field plan](../planning/mapping-field-trial.md) describes the photo split, geometry measurements and guest test.
