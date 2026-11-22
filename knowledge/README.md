# Team notebook

Use this folder for knowledge a teammate will still need after your branch merges. Anyone on the team can edit a note in GitHub or their local clone. Git keeps its history, and Entire Brain can index the merged Markdown in each teammate’s clone.

## Decisions we work from

| Decision | Why we made it | Source |
| --- | --- | --- |
| Ship one scan that opens from an unlisted link on a second phone first. | It exercises the capture export, upload, permissions and guest viewer together. | [Architecture](../docs/architecture.md) |
| Public scans appear in discovery. Unlisted scans open by link. Private scans require an owner or invited account. | Map owners choose an audience for both the scene and its underlying files. | [Sharing rules](../docs/architecture.md#sharing) |
| GitHub holds the source and team checkpoints. The live site and scan storage need a runtime of their own. | A guest needs an HTTPS URL they can open without access to the team repository. Vultr is a deployment proposal. | [Deployment plan](../docs/deployment.md) |

## Retrying iPhone capture uploads

After the API and CPU worker receive the [camera pose tolerance](../docs/capture-api.md#manifest-version-1),
retry the original version 1 bundle. Both accept float rounding in the final camera matrix
entry and preserve the recorded poses. On macOS, the Swift exporter and a local PostgreSQL
worker completed 32 sections with 313 photo poses from a saved iPhone walk. All 441
uploaded files matched their checksums. The [contract regression test](../services/api/src/lib/api/lidar-contract-compatibility.test.ts)
exercises the tolerated range and rejection cases with synthetic data.

## iOS scanner account

The [scanner sign-in instructions](../apps/capture/README.md#ios-scanner-sign-in) give Anish and Krishna the native application's callback and logout URI. The iPhone 16 Pro simulator running iOS 18.6 reached the hosted login form and returned signed out after cancellation. The [scanner check](../scripts/check-ios-scanner.sh) exercises account navigation and local review of a synthetic scan. Use a test account to verify the return with a profile, restoration after relaunch and logout.

## Calibration handoff

The [calibration trace and repair](../docs/scan-calibration.md) records why capture
metres were lost at approval, the CPU provenance gate, and the owner repair action.
Sam need not change production records or the capture contract; Arielle's editor
now separates metric scale from alignment. The synthetic `mock-lidar` remains
unverified unless an owner independently confirms its scale.

## Automatic routing handoff

The [scan routing runbook](../docs/scan-automatic-routing.md) records the viewer
integration and elevated doorway GLB checks. Arielle can use the existing floor
picks; Sam need not add navigation APIs or database fields. Anish/Krishna still need
to validate geometry coverage and measured clearance on a real approved capture.

## Browser upload and missing model files

On 2026-11-22, the deployed React form sent `POST /api/scans?format=glb`,
but the backend had only space-scoped multipart uploads. The browser import
contract and its checks are now described in [Scan API](../docs/scan-api.md).
Sam owns the API/storage repair; Arielle consumes `{id, shareId, sharePath, name}`
and must use `id` when changing a newly uploaded map's sharing.

A successful signed-in `GET /api/scans/:id` followed by a 404 from its `/file`
route means the authorized row exists but its storage object is missing. This was
observed for the existing `sample triangle` test model. Keep database records and
model bytes on the same deployment: use persistent absolute `SCAN_STORAGE_DIR`,
`CAPTURE_STORAGE_DIR` and `REVISION_STORAGE_DIR` paths across release swaps.
Do not make a private scan public to fix missing bytes. Locate and verify its
original file before restoring it. The two reported synthetic files were recovered
into `/var/lib/not404/scans/scans/` with private ownership and permissions; the
LiDAR file matched its approved revision SHA-256. The live API already had absolute
storage paths configured, but the scan directory and both objects were absent. The local upload regression uses a real hallway
GLB with disposable PostgreSQL and verifies a byte-identical signed-out download;
production recovery was checked separately through the live download service.

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


### Single uploaded GLB routing (2026-11-22)

Sam: browser imports have no approved capture calibration, so the old shared viewer
always disabled routing. Single-GLB previews now use the glTF metre/+Y convention
and label unverified scale; multi-scan alignment checks stay strict. Depth-fused
hallways also contain zero-area faces and exceed the old 200k triangle budget.
Skip only zero-area faces and allow bounded 2M triangle/vertex inputs. All four local
`paths/` GLBs generated connected routes; see [reproduction and limits](../docs/scan-automatic-routing.md#real-scan-verification-2026-11-22).
