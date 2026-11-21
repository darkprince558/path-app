# Gemini landmark assistant

Krishna owns this package. It asks Gemini for a short, visible landmark cue for **one turn the route graph has already verified**. It returns up to three **draft** candidates, or it explicitly abstains. An organizer must approve, edit or reject every draft before a guest sees it.

Gemini is not the route planner. This package never changes the maneuver, edits waypoints, reads GLB/PLY geometry, fetches URLs, stores anything or publishes content. Those are Sam's backend and Arielle's review UI. The brief is [docs/gemini-agent-handoff.md](../../docs/gemini-agent-handoff.md).

## Install and test

The package needs Python 3.11+, because the current `google-genai` SDK requires it. From `services/gemini/`:

```sh
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[test]"   # macOS/Linux: .venv/bin/python
.venv/Scripts/python -m pytest -q
```

Ordinary tests use no network and no API key. The live test is skipped unless you opt in.

## Configuration (server-side only)

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | required | Server secret. Never send it to the browser, log it or commit it. |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Model ID. Live-tested on 2026-11-21 (see Verification notes). Availability varies by API project. |
| `GEMINI_TIMEOUT_SECONDS` | `90` | Per-attempt HTTP timeout. 3.6 Flash can take tens of seconds when Google is busy. |
| `GEMINI_MAX_RETRIES` | `2` | Retries after the first attempt, at most 5. Only rate limits, timeouts, connection errors and 5xx are retried. |
| `GEMINI_MAX_IMAGE_BYTES` | `5242880` | Per-frame byte limit, checked before any call. |

The package reads only real environment variables. Only the test suite reads `services/gemini/.env`, which is gitignored, and only as a local convenience. See `.env.example`.

## How Sam's backend calls it

Sam first confirms that the segment and frame IDs belong to the requested immutable scan revision. Sam then loads the selected frames from private storage into memory. The browser sends only frame IDs.

```python
from path_gemini import (
    GeminiConfig, LandmarkService, LandmarkRequest, LandmarkError, ResultCategory,
)

service = LandmarkService(GeminiConfig.from_env())   # create once per process

request = LandmarkRequest.model_validate({
    "requestId": job.id,
    "scanRevisionId": revision.id,
    "routeSegmentId": segment.id,
    "approachDirectionId": "approach-a",          # opposite approach = separate request
    "waypoints": {
        "approachWaypointId": "wp-16",
        "junctionWaypointId": "wp-17",
        "exitWaypointId": "wp-18",
    },
    "verifiedMovement": {"maneuver": "left", "instruction": "Turn left at the junction"},
    "frames": [   # 2 or 3, one per role; order does not matter
        {"frameId": "frame-000138", "role": "approach", "mimeType": "image/jpeg",
         "imageBytes": storage.read_private(key_138), "timestampSeconds": 7.96},
        {"frameId": "frame-000142", "role": "junction", "mimeType": "image/jpeg",
         "imageBytes": storage.read_private(key_142), "timestampSeconds": 8.42},
        {"frameId": "frame-000150", "role": "exit", "mimeType": "image/jpeg",
         "imageBytes": storage.read_private(key_150), "timestampSeconds": 9.12},
    ],
})

try:
    result = service.propose_landmarks(request)
except LandmarkError as err:
    # Provider failure or rejected output. Not an abstention. The scan stays usable
    # and the organizer can type a landmark manually.
    save_draft(state="failed", error=err.to_dict())     # safe: no bytes, keys, or prose
else:
    save_draft(
        state="abstained" if result.category is ResultCategory.NO_CLEAR_LANDMARK else "awaiting_review",
        fingerprint=result.fingerprint,                  # idempotency / cache key
        validated=result.model_dump(mode="json", by_alias=True, exclude={"raw_response_text"}),
        raw_provider_response=result.raw_response_text,  # restricted audit field only
    )
```

`propose_landmarks(request)` is also available as a module-level function. It builds its service from environment variables on first use.

### What the result contains

`LandmarkGenerationResult` (camelCase via `model_dump(by_alias=True)`):

| Field | Use |
| --- | --- |
| `category` | `CANDIDATES` or `NO_CLEAR_LANDMARK`. An abstention is a successful result. |
| `candidates[]` | `landmark`, `visibleText`, `sourceFrameIds`, `instruction`, `visibility` (`clear`/`partial`/`uncertain`), `reason`. All are drafts. |
| `abstained`, `abstentionReason` | Explicit abstention. |
| `requiresReview` | Always `true`. |
| `requestId`, `scanRevisionId`, `routeSegmentId`, `approachDirectionId`, `maneuver`, `frameIds` | Echo of the verified inputs. `frameIds` is in walking order. |
| `provider`, `model`, `modelVersion`, `promptVersion` | Provenance (`promptVersion` is `landmark-v1`). |
| `elapsedMs`, `attempts`, `usage` | Timing, retry count and token usage when the SDK reports it. |
| `fingerprint` | `sha256:` over the scan revision, segment, approach, maneuver, ordered frame IDs, prompt version and model. `fingerprint_fields()` returns the inputs. |
| `rawResponseText` | The provider's JSON text, for a restricted audit column. It is hidden from `repr`. Never send it to a guest. |

Image bytes never appear in the result, its `repr`, logs or errors.

### Errors (`LandmarkError.code`)

| Code | Retried | Typical cause |
| --- | --- | --- |
| `INVALID_REQUEST` | no | Wrong frame count, duplicate or empty IDs, URL-like IDs, empty or oversized bytes |
| `UNSUPPORTED_MEDIA` | no | MIME type other than `image/jpeg` or `image/png` |
| `CORRUPT_IMAGE` | no | Bytes don't match the declared type |
| `CONFIGURATION_INVALID` | no | Missing key or a bad environment value |
| `GEMINI_AUTHENTICATION_FAILED` | no | Invalid or unauthorized key |
| `GEMINI_RATE_LIMITED` | yes | HTTP 429 or quota |
| `GEMINI_UNAVAILABLE` | yes (5xx/connection) / no (404 model, unknown) | Provider outage or a model unavailable to this project |
| `GEMINI_TIMEOUT` | yes | Client or server deadline |
| `GEMINI_SAFETY_BLOCK` | no | Prompt or answer blocked |
| `INVALID_MODEL_OUTPUT` | no | Bad JSON, schema mismatch, unknown frame ID, too many candidates, a URL or markup, or the instruction lacks the maneuver |
| `CONFLICTING_DIRECTION` | no | Any candidate's instruction names a different movement. The whole response is rejected. |

`NO_CLEAR_LANDMARK` is a successful result category, never an error. Retries use exponential backoff with jitter: about 0.5 s, then 1 s, capped at 8 s.

## Behavior

- **Prompt `landmark-v1`** (`prompt.py`): a system instruction covering the 12 handoff rules. The text gives the verified maneuver, the required phrase, the ordered waypoint IDs and the approach direction. Each image comes right after its `frameId`/`role` label, ordered approach → junction → exit. Any wording or schema change needs a new `PROMPT_VERSION`.
- **One request per call**, using the JSON schema (`response_json_schema`, with `sourceFrameIds` restricted to this request's frame IDs). Tools, search, URL context and automatic function calling are off. SDK retries are off because the service owns retries.
- **Maneuver wording.** Each instruction must use its maneuver's phrase family and no other direction:

  | Maneuver | Required wording (examples) | Notes |
  | --- | --- | --- |
  | `left` / `right` | "turn left" / "turn right" | "bear left" counts as `slight_left` and is rejected for `left` |
  | `slight_left` / `slight_right` | "bear/veer/keep (to the) left", "slight left" | |
  | `straight` | "straight", "continue/go ahead" | |
  | `u_turn` | "U-turn", "turn around", "go back" | |
  | `arrive` | "arrive", "destination" | May also say "on your left/right" |

  The check is deliberately strict. "Turn left at the door on your right" is rejected. Rejection is safer than shipping an ambiguous cue.
- **Limits:** instruction ≤ 140 characters, landmark ≤ 80, visibleText ≤ 60, reason ≤ 300, at most 3 candidates.
- **Telemetry:** one `path_gemini` log record per call. Fields: request, revision, segment and approach IDs, frame count, model, prompt version, elapsed ms, attempts and retry count, result category, error category, provider status, candidate count. Nothing else is logged.

## Try it on your own photos (trial runner)

`path_gemini.trial` sends 2–3 photos of one turn to Gemini and saves a report that shows each photo beside Gemini's answer. It also records the organizer's decision and prints evidence counts for the demo and Devpost. It is a local tool; Sam's backend does not use it. It makes real, billable calls with the key in `services/gemini/.env`.

It reads three folder layouts:
- Anish's native recorder output (`keyframes.json` with `photo-N.jpg`).
- The handoff's `frames.json`.
- A plain folder of JPEG/PNG photos.

With Pillow installed (`pip install -e ".[tools]"`), photos are re-encoded first. That drops EXIF and GPS metadata, applies orientation, and caps the longest side at 1280 px. Export iPhone HEIC photos as JPEG first.

From `services/gemini/` (Windows paths shown):

```powershell
# 1. See the frame IDs in a capture folder
.venv\Scripts\python -m path_gemini.trial list ..\..\captures-local\turn1

# 2. Run one verified turn (two or three of --approach/--junction/--exit)
.venv\Scripts\python -m path_gemini.trial run ..\..\captures-local\turn1 --maneuver left --approach photo-3 --junction photo-5 --exit photo-7 --label "Check-in to hardware lab" --open

# 3. Record what the organizer decided
.venv\Scripts\python -m path_gemini.trial decide <run-folder> accept            # candidate 0 unchanged
.venv\Scripts\python -m path_gemini.trial decide <run-folder> edit --candidate 1 --text "Turn left at the red door."
.venv\Scripts\python -m path_gemini.trial decide <run-folder> reject --note "landmark is temporary"
.venv\Scripts\python -m path_gemini.trial decide <run-folder> agree             # Gemini was right: no clear landmark
.venv\Scripts\python -m path_gemini.trial decide <run-folder> manual --text "Turn left at the fire door."

# 4. Evidence counts across all runs, with a ready-to-paste Devpost sentence
.venv\Scripts\python -m path_gemini.trial summary
```

Each run creates a folder under `captures-local/gemini-trials/`, which is Git-ignored. The folder holds:
- `run.json`: the inputs.
- `result.json` or `error.json`: the outcome.
- `images/`: the exact bytes sent.
- `decision.json`: the organizer's decision.
- `report.html`: a self-contained page with photos beside Gemini's answer, cited photos outlined. All text is escaped, and nothing loads from the network.

Reports embed private photos. The runner refuses any output folder inside the repository that Git would track. Run the opposite direction of a turn as a separate run with `--approach-direction approach-b`.

## Live test (opt-in, makes a real billable call)

From `services/gemini/`, with the key in the environment or in `services/gemini/.env`:

```powershell
$env:RUN_LIVE_GEMINI_TESTS = "1"; .venv\Scripts\python -m pytest tests/test_live_approved_fixture.py -s -v
```

By default this sends the **synthetic** frames from `fixtures/synthetic_frames.py`: a corridor with a purple panel, and a plain corridor. To use approved photos kept outside Git, also set `GEMINI_LIVE_FIXTURE_DIR` (see [fixtures/README.md](fixtures/README.md)). The test asserts stable properties only: schema validity, the maneuver preserved, only known frame IDs, and model and prompt metadata.

## Verification status

See **Verification notes** below. They are updated after each live run.

### Verification notes

- **Trial runner:** 14 offline tests cover the three folder layouts, EXIF/GPS stripping, runs, failures, decisions, summary counts, HTML escaping and the tracked-output guard. Live on 2026-11-21 with `gemini-3.6-flash`: the synthetic purple-panel turn gave 2 drafts in 13.3 s (1 attempt). The plain corridor abstained in 7.9 s. Both synthetic runs were then deleted so real evidence counts start at zero.
- **Mocked and offline:** 143 unit, response-validation, mocked-service and SDK-adapter tests pass (adapter with `generate_content` stubbed). No network or key is needed.
- **Live, synthetic fixture only, 2026-11-21, `google-genai` 3.6.1, prompt `landmark-v1`.** Each request sent three generated 320×240 PNGs, about 3,850 prompt tokens.

  | Model | `synthetic-landmark` | `synthetic-blank` (plain walls) | Latency |
  | --- | --- | --- | --- |
  | `gemini-3.6-flash` (default) | 2 candidates: "Turn left past the purple wall panel.", "Turn left at the dark doorway." | **Abstained**: "No distinctive visual landmarks…" | 95–108 s total, including 1–2 retries after Google 503/504 |
  | `gemini-3.5-flash-lite` | 1 candidate: "By the purple striped wall hanging, turn left." | 1 candidate, "dark doorway" (did not abstain) | 1.0–1.5 s, 1 attempt |

  Both runs passed the test's stable-property checks: the maneuver was preserved, only known frame IDs were cited, and model and prompt metadata were recorded. On the same day, `gemini-3.8-flash` and `gemini-3.7-flash` returned 503/504 even for a plain-text prompt. `gemini-2.5-flash` and `gemini-2.5-flash-lite` were listed by `models.list()` but returned 404. 3.6 Flash gave the better abstention. Flash-Lite is the fast fallback for a booth demo (`GEMINI_MODEL=gemini-3.5-flash-lite`). Re-run the live test before judging to pick between them.
- **Not yet verified:** Anish's real ARKit frames, Sam's backend integration and endpoints, and Arielle's organizer review. Do not claim the end-to-end landmark flow works until it has run through all three.
