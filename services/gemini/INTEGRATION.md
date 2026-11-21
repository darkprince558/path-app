# Connecting landmark cues to the app

How Gemini landmark cues fit with NavMesh routes, Anish's photos, Sam's backend and Arielle's viewer. The flow has two halves: **setup** (slow, organizer, once per map) and **guest** (instant, no Gemini).

```
SETUP   Anish scan + frames.json ─► Sam's backend ─► path-gemini service ─► drafts ─► Arielle review ─► approved cues
GUEST   pick start/end ─► NavMesh path ─► pathTurns() ─► matchCue() ─► "Turn left at the black door"
```

## 1. Turns: computed, then confirmed

Nobody types left or right. `pathTurns(points)` turns a NavMesh path, or any list of `{x,y,z}` points (metres, +Y up), into steps:

| Angle at a corner | Result |
| --- | --- |
| under 20° | straight (not announced) |
| 20–45° | `slight_left` / `slight_right` |
| 45–150° | `left` / `right` |
| over 150° | `u_turn` |
| steep climb or drop over 0.5 m | `stairs_up` / `stairs_down`, with `side` if you turn into them |
| last point | `arrive` |

There are two identical copies, and both pass `fixtures/turn_cases.json`:
- **TypeScript** for the viewer and the API: [`clients/typescript/turns.ts`](clients/typescript/turns.ts). No dependencies.
- **Python** inside the service: `path_gemini.turns`, also available as `POST /v1/turns`.

The organizer should confirm each computed turn once in the review screen, because a badly aligned scan could flip it.

## 2. Setup: make cues for each turn (Sam's backend)

For each turn the organizer wants a cue for:

1. **Pick photos.** `POST /v1/frames/select` with the turn and the capture's `frames.json` entries. It returns the best `approach`, `junction` and `exit` frame IDs, using Anish's camera poses. `usable: false` means fewer than two fit. Skip that turn, or let the organizer pick photos.
2. **Read those photos** from private storage.
3. **Ask for drafts.** Call `POST /v1/landmarks` with the turn's `maneuver` (and `side` for stairs) plus the 2–3 photos. `waypoints` is optional, so NavMesh corners don't need named points.
4. **Save the result**, keyed by turn: `position`, `incomingHeading`, `maneuver`, `side`. Also save `fingerprint`, `model`, `promptVersion`, `candidates` and `rawResponseText` (restricted). Status is `awaiting_review`, or `abstained` when `category` is `NO_CLEAR_LANDMARK`.
5. **The organizer decides** on Arielle's screen: accept, edit or reject. Store the approved text separately from Gemini's draft.

[`clients/typescript/landmarkClient.ts`](clients/typescript/landmarkClient.ts) wraps all three calls for Next.js (server-side only).

```ts
const gemini = new GeminiServiceClient();                     // GEMINI_SERVICE_URL + GEMINI_SERVICE_TOKEN
const turns = pathTurns(route.points).filter(t => t.maneuver !== "arrive");
for (const turn of turns) {
  const pick = await gemini.selectFrames(turn, frames, scan.transform);
  if (!pick.usable) continue;                                  // fall back to plain "Turn left"
  const roles = (["approach", "junction", "exit"] as const).filter(r => pick[r]);
  const result = await gemini.proposeLandmarks({
    requestId: crypto.randomUUID(), scanRevisionId: revision.id,
    routeSegmentId: `${revision.id}:${turn.index}`, approachDirectionId: headingKey(turn.incomingHeading),
    verifiedMovement: { maneuver: turn.maneuver, ...(turn.side ? { side: turn.side } : {}) },
    frames: await Promise.all(roles.map(async role => ({
      frameId: pick[role]!, role, mimeType: "image/jpeg" as const, image: await readFrame(pick[role]!),
    }))),
  });
  await saveDraft(turn, result);                               // awaiting_review / abstained
}
```

Errors throw `GeminiServiceError`. When `.retryable` is true (503/504), try again later; anything else marks the draft `failed`. A failed or empty result never blocks the map: the organizer can type a cue by hand.

## 3. Guest: show approved cues (Arielle's viewer)

```ts
const steps = pathTurns(navRoute.points);
for (const step of steps) {
  const cue = matchCue(step, approvedCues);                    // same maneuver, ≤2 m, same approach direction
  show(cue ? cue.approvedText : step.instruction);             // "Turn left at the black door" or "Turn left"
}
```

`matchCue` never reuses a cue recorded while walking the other way. Only organizer-approved text and photos reach guests: never drafts, `rawResponseText` or unapproved frames.

## 4. Running the service

```sh
cd services/gemini
pip install -e .
GEMINI_SERVICE_TOKEN=<long random string> python -m path_gemini.server   # http://127.0.0.1:8090
# or: docker build -t path-gemini . (see Dockerfile)
```

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | `{ok, model, promptVersion}` |
| `POST /v1/turns` | Bearer token | `{points}` → `{turns}` |
| `POST /v1/frames/select` | Bearer token | `{turn, frames, captureToSpace?}` → `{approach, junction, exit, usable}` |
| `POST /v1/landmarks` | Bearer token | landmark request with `frames[].imageBase64` → result |

Status codes: 400/415 bad input, 401 wrong token, 413 body over 24 MiB, 422 safety block, 502 Gemini output rejected (for example, a conflicting direction), 503 rate limit or outage (retry), 504 timeout (retry). Errors use `{error:{code,message,details}}`. The service never logs bodies, photos, prompts or keys. Keep it on a private network; it is not for browsers.

## Open questions to confirm

- **Camera frame vs space frame (Sam + Anish):** are Anish's `cameraToWorld` poses in the same frame as the GLB before `scan.transform`? If so, pass `scan.transform` as `captureToSpace`, as in the example above. If not, which matrix is it?
- **`frameId` vs `id` (Sam + Anish):** Anish's export writes `frameId`; Sam's `frames.json` v1 expects `id` and rejects unknown fields. The service and tester accept both.
- **Who stores cues (Sam):** the suggested key is turn position plus incoming heading plus maneuver/side, as `matchCue` expects.
