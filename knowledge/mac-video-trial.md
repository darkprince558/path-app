# Mac video reconstruction trial

November 21, 2026. Capture owners are Anish and Krishna. The web consumer is Arielle's guest viewer.

| Input | Result on the Apple Silicon Mac |
| --- | --- |
| Generated 18-second hallway with a gold door | 54/54 frames registered. The 5.57 MB PLY held 371,620 colored points. Chromium rendered both side walls, floor and the door. After one global scale, rotation and translation fit to the synthetic camera path, median distance to a known surface was 1.37 cm and the 95th percentile was 9.62 cm. |
| 18 seconds of TUM's Freiburg 2 Pioneer SLAM2 indoor robot recording, RGB only | 51/54 registered, 84,486 colored points, 1.27 MB. The final second dropped out. Wall and floor coverage remained patchy in the desktop viewer. The experiment supplied no camera poses, depth or scale and did not measure physical accuracy. |

Both exported files made a byte-identical round trip through the local mock as Unlisted. Both opened in the same guest renderer as PR #15. Point counts and runtimes can vary between mapping runs. Run the [synthetic check](../apps/capture/README.md#reproduce-the-local-check) before changing matching, orientation or depth filtering. It catches floating surfaces that a high point count can hide.

For a scale check, film a measured doorway from multiple positions and compare its width with the reconstruction. Check visibility on the guest phone separately when hosting is available. [Physical capture task](https://github.com/darkprince558/path-app/issues/4) · [Second-phone trial](https://github.com/darkprince558/path-app/issues/5)

The comparison clip uses video seconds 7–25 from the published RGB movie, re-encoded to H.264. Dataset by Jürgen Sturm, Nikolas Engelhard, Felix Endres, Wolfram Burgard and Daniel Cremers. [Original TUM RGB movie](https://cvg.cit.tum.de/rgbd/dataset/freiburg2/rgbd_dataset_freiburg2_pioneer_slam2-rgb.avi) · [Benchmark paper](https://cvg.cit.tum.de/_media/spezial/bib/sturm12iros.pdf) · [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)

## Walking-speed phone recording

A 15.7-second, 30 fps portrait recording on an iPhone 16 Pro supplied RGB video only. At eight keyframes per second, the largest connected incremental model covered 43 of 126 frames. Global mapping using SIFT registered all 126, with at least 20 triangulated observations on 115. Tracking points across 471 consecutive source frames and running global mapping brought that count to 123. The three weak poses occurred together near the turn around 5.5–5.9 seconds. The original and undistorted models had identical camera positions and rotations for all 126 images.

On the same Mac and camera path, stereo took 18 seconds and exported 600,000 colored points. OpenMVS took 156 seconds to fuse depth from 110 maps and export 495,211 points. The complete two-method run took 5 minutes 48 seconds. In the live viewer, switching methods keeps the same eye position, angle and point size. [Run the comparison](../apps/capture/README.md#compare-walls-and-floor-with-openmvs)

| Projected region | Views measured | Pixels covered by stereo | Pixels covered by OpenMVS |
| --- | ---: | ---: | ---: |
| Whole frame | 126 | 35.2% | 46.0% |
| Below-camera, nearly horizontal patches | 94 | 32.9% | 68.6% |
| Nearly vertical patches | 85 | 77.5% | 84.9% |

The offline comparison used 495,211 points per method, the same 288 × 512 views and a one-pixel-radius dot. Regions came from plane fits to the common sparse model and may include furniture. Coverage measures how much of the image contains projected points. Physical surface error remains unmeasured.

For the next trial, keep the existing walking pace through the straight section and keep a textured doorway or wall edge in sight from both sides of the turn. Compare that section with this baseline before requesting a slower retake. [Implementation and verification](https://github.com/darkprince558/path-app/pull/19)

## Photo-textured mesh from the same phone recording

Reusing the saved dense scene took 43 seconds on the M4 Pro. Of 496,391 fused samples, the point filter retained 480,718. It dropped 3,623 isolated dots and 12,050 points in small clusters. Of 217,929 native triangles, the pipeline discarded 28,186 with insufficient nearby measurements, 2,553 in small disconnected pieces, and 5,259 without photographic coverage. The 11.65 MB GLB contains 181,931 textured triangles and one embedded 4096 × 4096 atlas.

The cleaned cloud and mesh used the same viewer transform and camera poses. Across 126 calibrated, undistorted views, they filled 43.1% and 49.1% of the image respectively. In below-camera horizontal patches, coverage rose from 67.1% to 72.6% (94 qualifying views). In nearly vertical patches it rose from 83.2% to 85.6% (85 views). This comparison used the complete cleaned cloud and the exported mesh. The earlier stereo trial used different point sampling and image projections.

The floor looks continuous in several places where the point cloud shows individual dots. Substantial gaps persist around the turn, with 8.6% of one full frame covered at 8.4 seconds. Use **Solid** in the local viewer to inspect those boundaries, then **Textured** to compare the same triangles against the photographs. The footage supplies no surveyed dimensions. [Reproduce the mesh comparison](../apps/capture/README.md#compare-a-textured-mesh-with-its-points)
