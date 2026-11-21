import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { captures, processingJobs, scanRevisions, spaces, users } from '../../db/schema';
import { CpuCaptureProcessor } from '../processing/cpu-processor';
import { MockCaptureProcessor, type CaptureProcessor } from '../processing/processor';
import { CPU_PROCESSOR, selectedProcessor, processorTimeout } from '../processing/selection';
import { CaptureWorker } from '../processing/worker';
import { CAPTURE_CPU_LOCK } from '../processing/locks';
import { LocalCaptureStorage } from '../storage/captures';
import { LocalRevisionStorage } from '../storage/revisions';
import { ingestLidarFixture } from './fixtures/lidar-fixture';
import { readJob } from './jobs';
import { finalizeCapture } from './captures';

const native = new URL('../../../../../fixtures/lidar-native-capture/', import.meta.url);
const poll = async (condition: () => Promise<boolean>) => {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await condition()) return; await delay(25); }
  throw new Error('CPU test timed out waiting for state');
};
const live = async (pid: number) => {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux' && (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].startsWith('Z')) return false;
    return true;
  } catch { return false; }
};

test('processor selection is explicit, pinned and rejects invalid configuration', () => {
  assert.equal(selectedProcessor({}).id, 'mock-lidar');
  assert.deepEqual(selectedProcessor({ CAPTURE_PROCESSOR: 'cpu' }), CPU_PROCESSOR);
  assert.throws(() => selectedProcessor({ CAPTURE_PROCESSOR: 'unknown' }));
  assert.throws(() => processorTimeout({ CAPTURE_PROCESSOR_TIMEOUT_MS: 'NaN' }));
});

test('real CPU worker: uploaded native capture, failures, cancellation, exclusion and orphan recovery', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 60000,
}, async t => {
  const url = process.env.TEST_DATABASE_URL!;
  const client = postgres(url, { max: 5, prepare: false }), db = drizzle(client);
  const root = await mkdtemp(path.join(tmpdir(), 'not404-real-cpu-test-'));
  const captureStorage = new LocalCaptureStorage(path.join(root, 'captures'));
  const revisionStorage = new LocalRevisionStorage(path.join(root, 'revisions'));
  const cpu = new CpuCaptureProcessor({ databaseUrl: url, timeoutMs: 10000 });
  const worker = (processor: CaptureProcessor = cpu, signal?: AbortSignal) => new CaptureWorker({
    databaseUrl: url, captures: captureStorage, revisions: revisionStorage, processor,
    processors: [new MockCaptureProcessor()], signal, heartbeatMs: 25,
  });
  const prior = process.env.CAPTURE_PROCESSOR;
  process.env.CAPTURE_PROCESSOR = 'cpu';
  let spaceId: string | undefined, ownerId: string | undefined, child: ChildProcess | undefined;
  const marker = path.join(root, 'cpu-pid');
  const fakeCli = async (body: string) => {
    const file = path.join(root, `cli-${randomUUID()}.mjs`);
    await writeFile(file, `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},String(process.pid));\n${body}\n`);
    return file;
  };
  const waitPid = async () => {
    await poll(async () => { try { await readFile(marker); return true; } catch { return false; } });
    return Number(await readFile(marker, 'utf8'));
  };
  try {
    const suffix = randomUUID();
    const [owner] = await db.insert(users).values({ auth0Sub: `cpu-test|${suffix}`, username: `cpu_${suffix}`, displayName: 'CPU Owner' }).returning();
    ownerId = owner.id;
    const [space] = await db.insert(spaces).values({ ownerId, name: 'CPU fixture', visibility: 'private' }).returning();
    spaceId = space.id;
    const ingest = () => ingestLidarFixture(db, captureStorage, owner, space.id, native);

    await t.test('finalization pins CPU, creates one immutable private revision with verified native outputs', async () => {
      const capture = await ingest();
      const [queued] = await db.select().from(processingJobs).where(eq(processingJobs.id, capture.job.id));
      assert.equal(queued.configuration.processorId, cpu.id);
      assert.equal(queued.processorVersion, cpu.version);
      process.env.CAPTURE_PROCESSOR = 'mock';
      assert.equal((await finalizeCapture(db, captureStorage, owner, capture.capture.id)).job.id, queued.id);
      process.env.CAPTURE_PROCESSOR = 'cpu';
      assert.equal((await worker().runOnce(queued.id)).state, 'processed');
      const job = await readJob(db, owner, queued.id);
      assert.equal(job.status, 'succeeded'); assert.equal(job.attemptCount, 1);
      const [revision] = await db.select().from(scanRevisions).where(eq(scanRevisions.id, job.revisionId!));
      assert.equal(revision.status, 'draft'); assert.equal(revision.scanId, null);
      const report = revision.metadata.report as { captureId: string; sourceManifestSha256: string; masterTriangles: number; sceneTriangles: number; frames: unknown[] };
      assert.equal(report.captureId, capture.capture.deviceCaptureId);
      assert.notEqual(report.captureId, capture.capture.id);
      assert.equal(report.sourceManifestSha256, capture.capture.manifestSha256);
      assert.equal(report.masterTriangles, 200); assert.ok(report.sceneTriangles < 200);
      assert.equal(report.frames.length, 2);
      assert.equal((await worker().runOnce(queued.id)).state, 'idle');
      await assert.rejects(db.update(scanRevisions).set({ metadata: {} }).where(eq(scanRevisions.id, revision.id)));
    });

    await t.test('an independent CPU lifetime lock prevents claims even after the main worker lock is free', async () => {
      const capture = await ingest();
      const guard = postgres(url, { max: 1, prepare: false });
      try {
        await guard`SELECT pg_advisory_lock(${CAPTURE_CPU_LOCK})`;
        assert.equal((await worker().runOnce(capture.job.id)).state, 'busy');
        const job = await readJob(db, owner, capture.job.id);
        assert.equal(job.status, 'queued'); assert.equal(job.attemptCount, 0);
      } finally { await guard.end(); }
      await worker().runOnce(capture.job.id);
      assert.equal((await readJob(db, owner, capture.job.id)).status, 'succeeded');
    });

    await t.test('switching to CPU preserves and executes already-pinned mock jobs', async () => {
      process.env.CAPTURE_PROCESSOR = 'mock';
      const capture = await ingest();
      process.env.CAPTURE_PROCESSOR = 'cpu';
      assert.equal((await finalizeCapture(db, captureStorage, owner, capture.capture.id)).job.id, capture.job.id);
      await worker().runOnce(capture.job.id);
      const job = await readJob(db, owner, capture.job.id);
      assert.equal(job.processorId, 'mock-lidar'); assert.equal(job.status, 'succeeded');
    });

    await t.test('exit codes and invalid output are persisted safely without registering revisions', async () => {
      for (const [body, code] of [
        ["console.error('private-path-and-secret'); process.exit(2);", 'INVALID_INPUT'],
        ['process.exit(1);', 'PROCESSOR_FAILED'], ['process.exit(64);', 'PROCESSOR_USAGE'],
        ['', 'INVALID_OUTPUT'],
      ]) {
        const capture = await ingest(), cliPath = await fakeCli(body);
        await worker(new CpuCaptureProcessor({ databaseUrl: url, cliPath, timeoutMs: 5000 })).runOnce(capture.job.id);
        const job = await readJob(db, owner, capture.job.id);
        assert.equal(job.status, 'failed'); assert.equal(job.errorCode, code); assert.equal(job.revisionId, null);
        assert.ok(!JSON.stringify(job).includes('private-path-and-secret'));
      }
    });

    await t.test('timeout escalates to SIGKILL and cancellation waits until the child is dead', async () => {
      for (const mode of ['timeout', 'cancel']) {
        await rm(marker, { force: true });
        const cliPath = await fakeCli("process.on('SIGTERM',()=>{}); while(true) {}"), capture = await ingest();
        const controller = new AbortController();
        const run = worker(new CpuCaptureProcessor({ databaseUrl: url, cliPath,
          timeoutMs: mode === 'timeout' ? 1000 : 10000, killGraceMs: 50 }), controller.signal).runOnce(capture.job.id);
        const pid = await waitPid();
        assert.equal((await worker().runOnce()).state, 'busy');
        if (mode === 'cancel') controller.abort();
        await run;
        assert.equal(await live(pid), false);
        const job = await readJob(db, owner, capture.job.id);
        assert.equal(job.errorCode, mode === 'timeout' ? 'PROCESSOR_TIMEOUT' : 'PROCESSING_ABORTED');
        assert.equal(job.revisionId, null);
      }
    });

    await t.test('checksummed malformed GLBs are rejected and optional PLY can be omitted', async () => {
      const actual = fileURLToPath(new URL('../../../../../apps/capture/processor/cli.mjs', import.meta.url));
      for (const mode of ['bad-glb', 'no-ply']) {
        const capture = await ingest();
        const cliPath = await fakeCli(`
          import {readFile,writeFile,rm} from 'node:fs/promises';
          import {createHash} from 'node:crypto';
          import {pathToFileURL} from 'node:url';
          await import(pathToFileURL(${JSON.stringify(actual)}));
          const output=process.argv[process.argv.indexOf('--output')+1];
          const report=JSON.parse(await readFile(output+'/report.json','utf8'));
          if (${JSON.stringify(mode)} === 'bad-glb') {
            const bad=Buffer.from('not a valid GLB'); await writeFile(output+'/scene.glb',bad);
            report.assets['scene.glb']={byteSize:bad.length,sha256:createHash('sha256').update(bad).digest('hex')};
          } else { await rm(output+'/scene.ply'); delete report.assets['scene.ply']; }
          await writeFile(output+'/report.json',JSON.stringify(report));
        `);
        await worker(new CpuCaptureProcessor({ databaseUrl: url, cliPath, timeoutMs: 10000 })).runOnce(capture.job.id);
        const job = await readJob(db, owner, capture.job.id);
        assert.equal(job.status, mode === 'bad-glb' ? 'failed' : 'succeeded');
        if (mode === 'bad-glb') { assert.equal(job.errorCode, 'INVALID_OUTPUT'); assert.equal(job.revisionId, null); }
      }
    });

    await t.test('SIGKILLed parent cannot leave a CPU process running during a retry', async () => {
      await rm(marker, { force: true });
      const cliPath = await fakeCli("process.on('SIGTERM',()=>{}); while(true) {}"), capture = await ingest();
      child = spawn(process.execPath, ['--import', 'tsx', new URL('./fixtures/cpu-crash-worker.ts', import.meta.url).pathname], {
        env: { ...process.env, CAPTURE_TEST_STORAGE: path.join(root, 'captures'), REVISION_TEST_STORAGE: path.join(root, 'revisions'),
          CAPTURE_TEST_CLI: cliPath, CAPTURE_TEST_JOB: capture.job.id }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.resume(); child.stderr?.resume();
      const pid = await waitPid();
      assert.equal((await worker().runOnce(capture.job.id)).state, 'busy');
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; child = undefined;
      let result: Awaited<ReturnType<CaptureWorker['runOnce']>>;
      await poll(async () => { result = await worker().runOnce(capture.job.id); return result.state !== 'busy'; });
      assert.equal(await live(pid), false);
      const job = await readJob(db, owner, capture.job.id);
      assert.equal(job.status, 'succeeded'); assert.equal(job.attemptCount, 2);
      assert.ok(job.errors.some(error => (error as { code: string }).code === 'WORKER_INTERRUPTED'));
      assert.equal((await db.select().from(scanRevisions).where(eq(scanRevisions.processingJobId, job.id))).length, 1);
    });
  } finally {
    if (child?.pid) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    if (prior === undefined) delete process.env.CAPTURE_PROCESSOR; else process.env.CAPTURE_PROCESSOR = prior;
    if (spaceId) {
      const captureRows = await db.select({ id: captures.id }).from(captures).where(eq(captures.spaceId, spaceId));
      const ids = captureRows.map(row => row.id);
      if (ids.length) { await db.delete(scanRevisions).where(inArray(scanRevisions.captureId, ids));
        await db.delete(processingJobs).where(inArray(processingJobs.captureId, ids)); await db.delete(captures).where(inArray(captures.id, ids)); }
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    }
    if (ownerId) await db.delete(users).where(eq(users.id, ownerId));
    await client.end(); await rm(root, { recursive: true, force: true });
  }
});
