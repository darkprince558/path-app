# Gemini fixtures

Only synthetic metadata and code live here. **No photos are committed.**

| File | Purpose |
| --- | --- |
| `synthetic_left_turn.json` | Request metadata for a verified left turn with approach, junction and exit frames. It uses the frame ID shape from Anish's proposed `frames.json` contract. |
| `synthetic_frames.py` | Draws the matching 320×240 PNG frames in memory with the standard library. The `landmark` scene has a purple panel beside a left-hand opening. The `blank` scene has plain walls and should abstain. |

To look at the drawings, write them to an ignored folder:

```sh
python fixtures/synthetic_frames.py synthetic-preview
```

## Approved real photos

Real venue frames stay out of Git. To run the live test against photos the owner has approved, put them in a folder outside the repository, or in the ignored `captures-local/`. Add a `fixture.json` to that folder with the same shape as `synthetic_left_turn.json`, and give each frame an `imagePath` relative to the folder. Then set `GEMINI_LIVE_FIXTURE_DIR` to that folder. See the package README for the exact command.

Still needed (from the handoff): a blurry sign, a temporary person or cart, and the same junction from the opposite approach. These require real or approved captures; mocked tests already cover an unknown frame ID and a contradicting turn.
