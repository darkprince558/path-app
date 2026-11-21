# Mac video reconstruction trial

November 21, 2026. Capture owners are Anish and Krishna. The web consumer is Arielle's guest viewer.

| Input | Result on the Apple Silicon Mac |
| --- | --- |
| Generated 18-second hallway with a gold door | 54/54 frames registered. The 5.57 MB PLY held 371,620 colored points. Chromium rendered both side walls, floor and the door. After one global scale, rotation and translation fit to the synthetic camera path, median distance to a known surface was 1.37 cm and the 95th percentile was 9.62 cm. |
| 18 seconds of TUM's Freiburg 2 Pioneer SLAM2 indoor robot recording, RGB only | 51/54 registered, 84,486 colored points, 1.27 MB. The final second dropped out. Wall and floor coverage remained patchy in the desktop viewer. The experiment supplied no camera poses, depth or scale and did not measure physical accuracy. |

Both exported files made a byte-identical round trip through the local mock as Unlisted. Both opened in the same guest renderer as PR #15. Point counts and runtimes can vary between mapping runs. Run the [synthetic check](../apps/capture/README.md#reproduce-the-local-check) before changing matching, orientation or depth filtering. It catches floating surfaces that a high point count can hide.

For the real phone trial, film a measured doorway from multiple positions and compare its color, shape and adjacent wall coverage with the recording. Check visibility on the guest phone separately when hosting is available. [Physical capture task](https://github.com/darkprince558/path-app/issues/4) · [Second-phone trial](https://github.com/darkprince558/path-app/issues/5)

The comparison clip uses video seconds 7–25 from the published RGB movie, re-encoded to H.264. Dataset by Jürgen Sturm, Nikolas Engelhard, Felix Endres, Wolfram Burgard and Daniel Cremers. [Original TUM RGB movie](https://cvg.cit.tum.de/rgbd/dataset/freiburg2/rgbd_dataset_freiburg2_pioneer_slam2-rgb.avi) · [Benchmark paper](https://cvg.cit.tum.de/_media/spezial/bib/sturm12iros.pdf) · [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
