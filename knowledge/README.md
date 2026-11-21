# Team notebook

Use this folder for knowledge a teammate will still need after your branch merges. Anyone on the team can edit a note in GitHub or their local clone. Git keeps its history, and Entire Brain can index the merged Markdown in each teammate’s clone.

## Decisions we work from

| Decision | Why we made it | Source |
| --- | --- | --- |
| Ship one scan that opens from an unlisted link on a second phone first. | It exercises the capture export, upload, permissions and guest viewer together. | [Architecture](../docs/architecture.md) |
| Public scans appear in discovery. Unlisted scans open by link. Private scans require an owner or invited account. | Organizers choose an audience for both the scene and its underlying files. | [Sharing rules](../docs/architecture.md#sharing) |
| GitHub holds the source and team checkpoints. The live site and scan storage need a runtime of their own. | A guest needs an HTTPS URL they can open without access to the team repository. Vultr is a deployment proposal. | [Deployment plan](../docs/deployment.md) |

## Capture findings

- [Recording a scan from the Path App website](iphone-browser-capture.md) covers the iPhone browser boundary and first-party capture options.

## Add a finding

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
