# Real CPU capture processing

Owner: Sam. CPU geometry producer: Anish. Branch `integration/lidar-cpu-worker`
builds on contract integration commit `2494c61`; it does not merge or alter teammate
PRs. No Drizzle/schema changes or remote migrations are required.

## Dependencies and selection

Use Node 22.12+ on Linux/macOS, the full API source workspace (including its worker
scripts and `.mjs` watchdog files), and Anish's CPU package. The package uses glTF
Transform, Meshoptimizer/WASM, glTF Validator, Sharp/libvips and Zod. It does not
require Xcode, GPUs or Vultr for processing an already exported bundle. Xcode is
still needed to build/run the native scanner. Keep storage on a private persistent
disk available to API and worker. A `.next` deployment alone does not include the
separate source worker or CPU package.
Use the same service user (or explicit equivalent private access) for the API and
worker: local capture files/directories use 0600/0700 permissions.

```sh
cd /tmp/path-lidar-cpu
npm ci --prefix services/api
npm ci --prefix apps/capture/processor
```

Set these values in `services/api/.env.local` or the process supervisor environment:

```dotenv
CAPTURE_PROCESSOR=cpu
CAPTURE_PROCESSOR_TIMEOUT_MS=300000
# Optional absolute path to the trusted Node CLI (root symlink also supported):
# LIDAR_PROCESSOR_PATH=/absolute/checkout/process_lidar_capture
CAPTURE_STORAGE_DIR=/absolute/private/captures
REVISION_STORAGE_DIR=/absolute/private/revisions
```

Retain the existing Auth0 configuration and `DATABASE_URL`; never put credentials
in arguments, Git or browser code. The API and worker must use the same database
and private storage directories. The CPU watchdog uses a second PostgreSQL session,
with no extra tables/extensions. Use direct/session-preserving connections, not
transaction pooling. Restart API and worker after changing selection.
Stop older worker releases before finalizing CPU captures; do not mix workers that
lack the CPU lifetime-lock probe with this release.

`CAPTURE_PROCESSOR` accepts `cpu` or `mock`; default `mock` preserves existing
installations/tests until an operator explicitly selects CPU. New finalizations pin
`lidar-cpu / 1-contract-v1` or `mock-lidar / 1` into the existing job row. Already
queued jobs never change processor on a finalize retry. The worker registers both
adapters so switching new captures to CPU does not strand old mock jobs. An unknown
pinned identity/version fails explicitly; it is never silently substituted.

The CLI override is server/operator configuration, not a request parameter. It must
be Anish's trusted Node ESM CLI compatible with `process_lidar_capture`, not an
arbitrary executable. The adapter supplies only a minimal environment and never
buffers or persists arbitrary stdout/stderr. Deadline accepts 1..3,600,000 ms.

## Process one uploaded capture

1. With the configuration above loaded, start the API from this integration checkout:

   ```sh
   cd services/api
   npm run dev
   ```

2. Sign in through existing Auth0 as the owner of a space. Upload the dedicated
   `fixtures/lidar-native-capture/` directory (or a compatible real iPhone export)
   using the exact directory-picker browser example in [capture-api.md](capture-api.md#reproduce-the-fixture).
   Register `{spaceId,manifest}`, upload each declared payload, then finalize.
   Registration creates the database capture UUID. Use that returned `capture.id`
   in upload/finalize URLs; do not rewrite the manifest/device UUID. The ZIP and
   manifest itself are not payload uploads. Keep the `job.id` and `job.statusPath`
   returned by finalization.

3. Process just that job in a second terminal, loading the same `.env.local`:

   ```sh
   cd /tmp/path-lidar-cpu/services/api
   npm run worker:captures -- --job-id REPLACE_WITH_FINALIZE_JOB_UUID
   ```

   `--job-id` performs one targeted attempt and exits; another active worker may
   cause a busy result without a claim. Without it, `--once` attempts FIFO once,
   or no flags runs the supervised polling loop. Do not run an older release's
   worker against this queue: all workers must honor the CPU lifetime lock.

4. Poll the returned `GET /api/jobs/<jobId>` in the signed-in browser. It must show
   `processorId: "lidar-cpu"`, `status: "succeeded"`, progress 100 and an immutable
   draft `revisionId`. A configured failure shows a saved safe error code/history.
   Success creates private `master.glb`, `scene.glb`, `preview.jpg`, `report.json`
   and optional `scene.ply`, not an automatically published scan. Approve through
   the existing [publishing workflow](lidar-publishing.md) to expose its scene.

An already finalized mock job remains mock even after changing the setting. This
task adds no reprocess endpoint and does not mutate old jobs. Use a new genuine
device/take UUID for a new capture; do not overwrite an immutable registered bundle.
Future reprocessing should enqueue a separate version-pinned job/revision.

## Reliability and validation

The existing worker retains the global PostgreSQL advisory lock, one-running-job
index, durable claims, input rehashing, heartbeat fencing, interruption history,
three-interruption recovery budget and atomic success/revision registration.

The real adapter reads the trusted materialized manifest and supplies its device
UUID to `--expected-capture-id`. It runs a Node child with no shell. The worker's
pre-created empty output directory contains an initially absent `cpu-result`
destination, satisfying the CLI's atomic publication contract. After successful
exit, the adapter checks inventory, report size, device ID, canonical input digest,
coordinates, entrance pose, exact frame metadata, and each output hash/size. Only
then are files moved into the normal revision validator. That validator independently
checks bounded regular files, symlinks, self-contained GLBs, JPEG/PLY headers and
JSON, calculates its own digests, and promotes immutable 0600 private files.

Cancellation or deadline sends process-group SIGTERM, escalates to SIGKILL after
one second and waits for `close` before a job can fail/retry. A watchdog thread in
the CLI process owns advisory lock `4042027`, monitors a parent-lifetime socket,
the DB session and an independent hard deadline. It can kill the entire CLI group
even while the main CLI thread is busy in synchronous WASM/native code. Replacement
workers probe this lock before recovering any job; they return busy while it remains
held. The original worker lock stays `4042026`. No PID is saved in the database,
avoiding unsafe PID-reuse killing during recovery. Lock correctness depends on a
session-preserving PostgreSQL connection and running the updated worker release.

Exit mapping: 2 → `INVALID_INPUT`, 1 → `PROCESSOR_FAILED`, 64 → `PROCESSOR_USAGE`,
75 → `WORKER_INTERRUPTED`; unexpected exits/signals have separate safe codes.
Timeout → `PROCESSOR_TIMEOUT`; cancellation → `PROCESSING_ABORTED`; invalid report,
inventory or output checksums → `INVALID_OUTPUT`. Errors do not register revisions.
Abrupt worker death leaves a running row; recovery records `WORKER_INTERRUPTED`
before retrying, preserving prior history. A parent killed during materialization
can leave a private temporary workspace, as before; cleanup/retention is deferred.

The command cleans/simplifies an existing ARKit mesh. It does not reconstruct missing
floor coverage, certify physical scale/walkability, generate NavMesh or invoke Gemini.

## Local verification

Use only a disposable local PostgreSQL database with existing migrations already
applied and a `TEST_DATABASE_URL`. Never point regression/crash tests at Tiger Data.

```sh
cd services/api
# Export TEST_DATABASE_URL and the test-only Auth0 settings documented by the API tests.
npm test
npm run typecheck
npm run db:check
npm run contract:check
# With placeholder Auth0 settings and no reachable DB:
DATABASE_URL=postgresql://none:none@127.0.0.1:1/none APP_BASE_URL=http://localhost:3000 npm run build -- --webpack
cd ../..
npm test --prefix apps/capture/processor
make check
```

`cpu-processing.test.ts` uploads the shared native fixture through the existing
capture services into private storage, finalizes a CPU job, invokes the real CLI,
and checks one immutable draft with matching device provenance and simplified
geometry. It covers saved exit errors, invalid outputs, timeouts, cancellation,
SIGKILL escalation, concurrent-worker exclusion and a real worker SIGKILL during
synchronous CPU work followed by successful recovery with one revision. Existing
mock worker tests, including the crash after promotion/before commit, still run.

Verified locally on Linux against disposable PostgreSQL: 39 API tests passed and
one optional real-reconstruction test skipped; all three standalone processor tests,
typecheck, Drizzle check, contract drift check, production webpack build and
`make check` passed. The build retains the upstream Auth0 dynamic-dependency warning.
The targeted worker command was also exercised against a nonexistent local job and
returned `{"state":"idle"}`. These checks use synthetic assets and do not claim a
physical iPhone capture, measured venue quality or a remote Tiger Data deployment.
