# Which phone sensors the scanner uses, and for what

Date and contributor: November 22, 2026. Anish, with Claude Code.

Question or decision: whether GPS, compass, barometer and our own gyro log improve the scanner beyond ARKit.

What we observed (from published work, not from our own device yet):

- **Do not out-fuse ARKit.** ARKit ended 0.14–0.79 m off after 84–145 m indoor loops on an iPhone 12 Pro Max ([Kim et al., Sensors 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC9785098)). Position tracking stays with ARKit.
- **Barometer: floor changes only.** The pressure step between two floors was stable to about 0.2 hPa (1.6 m) and floor-change detection was 99.5% accurate, but two phones of the same model differed by about 10 m in absolute terms and a still phone drifted 1.4 m in 15 minutes ([Muralidharan et al., HotMobile 2014](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/hotmobile14b.pdf)). In a closed elevator no tracking system tested in ADVIO (2018) could measure the ride, so pressure is the only signal there.
- **GPS: entrance tag and outdoor trails only.** Expect roughly 5–10 m in the open and 20–100 m beside buildings (summaries of Android studies).
- **Compass: one logged reading outdoors.** About 15° at best outdoors and 17–26° indoors in the studies summarised. The session stays `.gravity`.
- **Gyro and exposure: photo sharpness.** Smear in pixels is about focal length × exposure × (turn rate + sideways speed ÷ distance). The idea of dropping the blurriest candidates comes from [arXiv 2403.13327](https://arxiv.org/abs/2403.13327).

Evidence: the rules are in `apps/capture/PathCapture/WalkSensors.swift` and checked by `apps/capture/native-tests/SensorChecks.swift` on synthetic traces (stairs, an elevator, weather drift, a pressure spike, lost tracking). Research notes: `research_notes/Scanner v1 prior art/sensors.md` in Anish's working folder.

What the next teammate should do, on a real iPhone:

1. Start a walk and confirm barometer readings arrive: **Walk review → Sensors** should not say "No barometer readings were saved". One forum report (seen only as a search summary) says relative altitude never arrived on an iPhone 16 Pro.
2. Climb one flight of stairs and ride an elevator. Record what the app reported against the real height, and tune `FloorChangeDetector.threshold` and `settleSeconds`.
3. Walk one corner fast and one slowly and compare the saved `photo-*.jpg` and their `blurPixels`. Tune `KeyframeGate.limit`.
4. Record typical `ARCamera.exposureDuration` in a dim corridor; it decides how strict the limit can be.
