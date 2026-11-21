# Gemini landmark directions

**Proposed prize demo.** A visitor opens a shared scan and sees “Turn left at the purple mural.” Tapping the cue shows the doorway as it looked to the person who recorded the walk. A judge can compare the cue with the physical junction and try the turn on a second phone.

## Build one recognizable turn

1. **Krishna and Anish** capture a short permitted route with one junction. Export a colored scan plus two or three still photos of the turn from a walker's viewpoint. Label each still with its frame ID, scan revision and manually confirmed waypoint. Keep the original photos alongside the PLY for landmark analysis.
2. **Sam** sends the organizer-selected images to Gemini from the backend. Label each image with its supplied ID. Include the ordered approach, junction and exit waypoints, plus the turn direction already computed from the verified route. Ask Gemini for an object or sign visible from this approach, its supporting frame IDs, and one short guest instruction using the supplied turn. Request an empty list when the evidence is unclear. Gemini supports multiple images in one request and JSON Schema-constrained responses. [Image inputs](https://ai.google.dev/gemini-api/docs/image-understanding#multiple-images) · [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
3. **Arielle** shows the draft beside its source photos. The organizer accepts, edits or rejects it. Publish accepted text and any specifically approved photo with the same access controls as the scan. A visitor opening the link sees the cue at the junction.

For an illustrative request, use the directed route `entrance → junction → workshop`, a verified left turn, and two frames tagged `junction`. The sample response links the cue to both frames.

```json
{
  "cues": [{
    "waypointId": "junction",
    "frameIds": ["approach-01", "junction-02"],
    "landmark": "Purple mural beside the doorway",
    "instruction": "Turn left at the purple mural."
  }]
}
```

This example is invented. In the implementation, validate every waypoint and frame against the supplied scan revision, verify that each frame belongs to the requested turn, and bind the approved cue to this direction of travel. A guest approaching from the opposite direction needs the appropriate turn instruction. The route graph remains the source of walkable edges. Keep the API key on the server and record the model ID, prompt version and elapsed time for the actual run.

## What to show judges

- **Gemini.** Run inference on fresh frames at the booth. Show one generated cue, the frames that support it, the organizer's decision, and the instruction appearing on a second phone. Bring a recording of a successful run for network failures and identify it as a recording.
- **Adventure.** Let a first-time visitor choose between two destinations. Have someone else walk the chosen route using the shared scan. Film the real turn beside the matching view so judges can see whether the landmark helped. A second contributor can add a previously unmapped branch if the core demo works.
- **Evidence.** Before judging, label several real turns by hand and include one blurred or blank frame. Record exact counts of suggestions accepted unchanged, edited, rejected, and cases where Gemini abstained. Record whether a first-time walker reached the chosen destination without coaching. Report the observed counts and sample size.

The first implementation can attach approved landmark labels to the shared scan while routing is under development. A failed or empty generation leaves the scan viewable and lets the organizer enter a label manually.
