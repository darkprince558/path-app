# Team notebook

Use this folder for knowledge a teammate will still need after your branch merges. Anyone on the team can edit a note in GitHub or their local clone. Git keeps its history, and Entire Brain can index the merged Markdown in each teammate’s clone.

## Decisions we work from

| Decision | Why we made it | Source |
| --- | --- | --- |
| Ship one scan that opens from an unlisted link on a second phone first. | It exercises the capture export, upload, permissions and guest viewer together. | [Architecture](../docs/architecture.md) |
| Public scans appear in discovery. Unlisted scans open by link. Private scans require an owner or invited account. | Map owners choose an audience for both the scene and its underlying files. | [Sharing rules](../docs/architecture.md#sharing) |
| GitHub holds the source and team checkpoints. The live site and scan storage need a runtime of their own. | A guest needs an HTTPS URL they can open without access to the team repository. Vultr is a deployment proposal. | [Deployment plan](../docs/deployment.md) |

## Add a finding

[LiDAR ingestion contract and exporter handoff](lidar-ingestion.md) records the
implemented backend example and native capture checks still required.
The [contract integration handoff](../docs/lidar-contract-compatibility.md) records
the device/database UUID distinction, generated CPU validators and separate native fixture.

The [CPU worker handoff](../docs/lidar-cpu-processing.md) records the real adapter,
child-owned lifetime lock, process cancellation and targeted local workflow.

The [publishing runbook](../docs/lidar-publishing.md) records Task 5's approved
revision-to-scan link, owner-only frames and verified synthetic viewer handoff.

Create a short Markdown file here such as `capture-export.md` for a finding worth reusing. Use the real device, command or example that produced it. Link to the implementation PR or issue and add a link to the note here. If the result changes the first supported format or another team decision, update the linked architecture or plan as part of the same PR.

```markdown
# Short topic
Date and contributor:
Question or decision:
What we observed:
Evidence (device, command, issue, PR or checkpoint ID):
What the next teammate should do:
```

After pulling a note, run `entire brain refresh` in the repo, then try `entire brain query "scan visibility" --source doc --limit 3`. Keep raw scans, credentials and full transcripts in their approved storage. A reference to the evidence is enough here.

- **Continuous hallway capture.** A real iPhone take crossed the previous 220,000-face stop after about 15 seconds. Hallway mode now checkpoints sections in one AR session. When processing a walk, use the ordered sections in its complete archive. Each raw LiDAR depth frame needs its recorded intrinsics, world pose and confidence map when available. See the [capture and Mac fusion guide](../apps/capture/README.md#map-a-hallway) and [two-section reconstruction check](../apps/capture/walk/test_reconstruct.py).

- **Live side guidance.** Four saved iPhone walks supplied 910 depth frames for a chronological replay. On one walk the cue pointed right in both stretches where the finished scan showed weak right-side coverage. A route with little upright evidence on either side yielded one brief cue. For the next physical check, deliberately omit a known wall and note where the arrow appears and clears. The recordings had no independent labels for missed surfaces. [Scanner behavior](../apps/capture/README.md#map-a-hallway) · [Local depth replay](../apps/capture/native-tests/replay-side-guidance/main.swift)
