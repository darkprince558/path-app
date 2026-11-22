# Asynchronous capture processing

Human owner: Sam. Processor producer: Anish. Uses the existing Tiger Data PostgreSQL
connection, Auth0 and private capture storage. `CAPTURE_PROCESSOR=cpu` selects Anish's
real CPU cleanup/simplification CLI; `mock` retains the synthetic copy adapter.
Neither verifies physical alignment/walkability, invokes Gemini, publishes navigation
or changes the frontend. See the [real CPU workflow](lidar-cpu-processing.md).

## Run and inspect

Capture finalization now atomically inserts one queued job and returns
`{capture,job:{id,status,statusPath}}`, retaining HTTP 200. Identical retries return
the same logical job, including after failure/success. Previously uploaded captures
gain an initial job when their owner calls finalize again; there is no bulk backfill
or public retry/reprocess endpoint.

```sh
cd services/api
# After reviewing migration 0003, apply pending migrations manually:
npm run db:migrate

# Run separately from Next.js under a process supervisor:
npm run worker:captures

# Or process at most one queued job and exit:
npm run worker:captures -- --once
```

The worker loads `.env.local`, then `.env`, preserving explicit environment variables.
Use the same DATABASE_URL and CAPTURE_STORAGE_DIR as the API. REVISION_STORAGE_DIR
defaults to `.local-revisions` in the API workspace; keep it private and outside
`public/`. Local worker instances need the same persistent disk. No migration is
run automatically. Implementation checks used only disposable local databases.

`GET /api/jobs/:jobId` requires the existing Auth0 session/bearer authentication and
ownership of the capture and its parent space. Other users receive 404, including
event members and guests of public spaces. Response:

```text
{job:{id,captureId,status,stage,progress,attemptCount,processorId,processorVersion,
      errorCode,errors,revisionId,createdAt,startedAt,heartbeatAt,completedAt,updatedAt}}
```

No object keys, lease tokens or configuration are exposed. Errors retain bounded
attempt history even after recovery succeeds. Known `ProcessingFailure` errors save
their safe code/message; unexpected exceptions save a generic failure, without
exposing arbitrary subprocess output. `processorId: "mock-lidar"` identifies the mock.

## Persistence and recovery

- PostgreSQL stores queued/running/succeeded/failed/cancelled states. Captures remain
  uploaded while these separate states track processing.
- A private single-connection PostgreSQL client holds a session advisory lock for
  the entire attempt. Competing workers return busy. A partial unique index also
  permits only one running job. Use a direct connection or session-preserving pool;
  transaction pooling cannot preserve this lock.
- Claims, attempt counts and fencing tokens commit before processing. Heartbeats
  refresh every five seconds, with a thirty-second lease timestamp. The worker
  never steals work merely because its heartbeat timestamp is old.
- After acquiring the global lock, a replacement worker records WORKER_INTERRUPTED
  for abandoned running capture jobs and requeues them. Three interrupted attempts
  exhaust the recovery budget and persist a failure. Interrupted work is never
  directly converted to success.
- Before recovery or claiming, every worker also probes the CPU lifetime advisory
  lock. The actual CLI process holds this lock through a watchdog thread. If a
  parent is SIGKILLed, the thread detects pipe EOF and kills the CLI process group,
  including synchronous CPU work. Recovery stays busy until that process releases
  its lock. Run API/workers from the same release; older workers lack this probe.
- Processor/validation failures become terminal failed jobs with saved code,
  message, attempt, stage and time; they do not retry automatically. SIGINT/SIGTERM
  aborts and records failure when possible. SIGKILL leaves running state visible
  until a replacement worker recovers it. A supervisor must restart crashed workers.
- Writes are fenced by job state, lease token and backend PID. Losing the database
  session prevents that attempt from committing success. Processing has a configurable
  five-minute default deadline. The CPU adapter sends process-group SIGTERM, then
  SIGKILL after one second, and awaits process/stdio closure before returning.
  Its independent watchdog also enforces a hard deadline and kills on lost DB session.
- Success and the revision row commit together only after validated, checksummed
  outputs are stored. Before that commit, a crash leaves a running job. After it,
  both success and revision persist and the job is not repeated.

## Processor and immutable revisions

`CaptureProcessor` supplies `{id,version,process({inputDir,outputDir,signal})}`. The
worker materializes a private bundle and rechecks every input hash, including the
manifest, against the queued input digest. Each attempt gets a separate workspace.
Queued processor ID/version are pinned; unavailable versions fail explicitly.

The CPU adapter invokes the Node CLI in a guarded child process with an argument
array, no shell, exit-code checks and cancellation. It supplies the device UUID:

```text
process_lidar_capture --input <bundle> --output <absent-revision> --expected-capture-id <device-uuid>
```

Expected files are master.glb, scene.glb, optional scene.ply, preview.jpg and
report.json. The mock copies source.glb into both GLBs, points.ply into scene.ply,
and the preview unchanged, then writes a report identifying the mock and lack of
physical verification. The CPU adapter invokes the real implementation in
`apps/capture/processor/cli.mjs`; its output is validated independently before storage.
The worker's empty output directory is retained: the CLI first writes to a fresh
`cpu-result/` child, then the adapter validates/moves completed files into that parent.

Output validation rejects unsupported/missing files, symlinks, empty/oversized
assets, invalid self-contained GLB containers, malformed JSON reports and invalid
JPEG/PLY headers. Container/header checks do not establish renderability or mesh
correctness. Limits are 100 MiB per output and 2 MiB for the report.

Private outputs use fresh revision UUIDs, 0600 files, synced writes and atomic
directory promotion. The revision records the scene checksum/key, full output
inventory, report, processor identity and input digest. Each job can register only
one revision; later jobs get new per-capture revision numbers. The migration's
trigger makes content/provenance immutable while allowing approval fields to change.
Revisions begin as unaligned drafts with no scan link; existing scans, routes,
graphs, events and access grants remain unchanged.

Promotion cannot join the PostgreSQL transaction. A crash after promotion but
before commit can leave private orphan outputs. Recovery uses a fresh UUID and
preserves those bytes. Garbage collection is deferred. Local disk is a development
adapter; loss of storage/database still requires normal backups.

## Checks

Run API typecheck, db:check, tests against a disposable migrated TEST_DATABASE_URL,
production build and root `make check`. Tests cover successes, saved processor and
output failures, single-worker exclusion, immutable revisions, retry exhaustion,
and real SIGKILL crashes before output and after promotion/before database commit.
They verify one committed revision after recovery and retained error history.
These are synthetic software checks, not physical-device LiDAR evidence.
