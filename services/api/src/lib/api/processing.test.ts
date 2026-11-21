import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { captures, processingJobs, scanRevisions, scans, spaces, users } from '../../db/schema';
import { CaptureWorker } from '../processing/worker';
import { MockCaptureProcessor, ProcessingFailure, type CaptureProcessor } from '../processing/processor';
import { LocalCaptureStorage } from '../storage/captures';
import { LocalRevisionStorage } from '../storage/revisions';
import { digestBytes, finalizeCapture, registerCapture, uploadCaptureFile } from './captures';
import { readJob } from './jobs';
import { captureManifest } from '../capture/contract';

const fixture = new URL('../../../../../fixtures/lidar-capture/', import.meta.url);
const fixtureFile = (file: string) => readFile(new URL(file, fixture));

test('durable processing: success, single active worker, failures, immutable revisions and crash recovery', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 30000,
}, async t => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 5, prepare: false });
  const db = drizzle(client);
  const root = await mkdtemp(path.join(tmpdir(), 'not404-worker-test-'));
  const inputRoot = path.join(root, 'captures'), outputRoot = path.join(root, 'revisions');
  const captureStorage = new LocalCaptureStorage(inputRoot);
  const revisions = new LocalRevisionStorage(outputRoot);
  const processor = new MockCaptureProcessor();
  const worker = (adapter: CaptureProcessor = processor) => new CaptureWorker({
    databaseUrl: process.env.TEST_DATABASE_URL!, captures: captureStorage, revisions, processor: adapter, heartbeatMs: 25,
  });
  let ownerId: string | undefined, viewerId: string | undefined, spaceId: string | undefined;
  let child: ChildProcess | undefined;
  try {
    const suffix = randomUUID();
    const [owner, viewer] = await db.insert(users).values([
      { auth0Sub: `worker|${suffix}`, username: `worker_${suffix}`, displayName: 'Owner' },
      { auth0Sub: `other-worker|${suffix}`, username: `other_worker_${suffix}`, displayName: 'Other' },
    ]).returning();
    ownerId = owner.id; viewerId = viewer.id;
    const [space] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Worker fixture', visibility: 'public' }).returning();
    spaceId = space.id;
    const makeCapture = async () => {
      const manifest = captureManifest.parse(JSON.parse((await fixtureFile('manifest.json')).toString()));
      manifest.captureId = randomUUID();
      const frames = JSON.parse((await fixtureFile('frames.json')).toString());
      frames.captureId = manifest.captureId;
      const frameBytes = Buffer.from(JSON.stringify(frames));
      Object.assign(manifest.files.find(file => file.path === 'frames.json')!, digestBytes(frameBytes));
      const { capture } = await registerCapture(db, captureStorage, owner, { spaceId: space.id, manifest });
      for (const file of manifest.files) {
        await uploadCaptureFile(db, captureStorage, owner, capture.id, new Request(
          `http://localhost/api/captures/${capture.id}/uploads?path=${encodeURIComponent(file.path)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
            body: file.path === 'frames.json' ? frameBytes : await fixtureFile(file.path),
          },
        ));
      }
      return finalizeCapture(db, captureStorage, owner, capture.id);
    };
    let successful: Awaited<ReturnType<typeof makeCapture>>;
    await t.test('queued jobs survive a new worker instance; success commits one validated draft', async () => {
      successful = await makeCapture();
      assert.equal(successful.job.status, 'queued');
      assert.equal((await finalizeCapture(db, captureStorage, owner, successful.capture.id)).job.id, successful.job.id);
      const result = await worker().runOnce(successful.job.id);
      assert.equal(result.state, 'processed');
      const job = await readJob(db, owner, successful.job.id);
      assert.equal(job.status, 'succeeded');
      assert.equal(job.progress, 100);
      assert.equal(job.attemptCount, 1);
      assert.ok(job.revisionId);
      const [revision] = await db.select().from(scanRevisions).where(eq(scanRevisions.id, job.revisionId!));
      assert.equal(revision.status, 'draft');
      assert.equal(revision.scanId, null);
      assert.equal(revision.revision, 1);
      const files = revision.metadata.files as { path: string; sha256: string; byteSize: number }[];
      assert.deepEqual(files.map(file => file.path).sort(), ['master.glb', 'preview.jpg', 'report.json', 'scene.glb', 'scene.ply']);
      for (const file of files) assert.deepEqual(digestBytes(await readFile(path.join(outputRoot, revision.id, file.path))), {
        sha256: file.sha256, byteSize: file.byteSize,
      });
      assert.deepEqual(await readFile(path.join(outputRoot, revision.id, 'scene.glb')), await fixtureFile('source.glb'));
      assert.equal((revision.metadata.report as { mock: boolean }).mock, true);
      assert.equal(revision.metadata.alignmentVerified, false);
      assert.equal((await worker().runOnce(successful.job.id)).state, 'idle');
      assert.deepEqual(await db.select().from(scans).where(eq(scans.spaceId, space.id)), []);
      await assert.rejects(readJob(db, viewer, successful.job.id), { status: 404 });
    });

    await t.test('another run creates a new immutable revision while approval remains editable', async () => {
      const firstJob = await readJob(db, owner, successful.job.id);
      const [first] = await db.select().from(scanRevisions).where(eq(scanRevisions.id, firstJob.revisionId!));
      const oldBytes = await readFile(path.join(outputRoot, first.id, 'scene.glb'));
      await assert.rejects(db.update(scanRevisions).set({ objectKey: 'changed' }).where(eq(scanRevisions.id, first.id)));
      await assert.rejects(db.update(scanRevisions).set({ metadata: {} }).where(eq(scanRevisions.id, first.id)));
      await db.update(scanRevisions).set({ status: 'approved', approvedBy: owner.id, approvedAt: new Date() }).where(eq(scanRevisions.id, first.id));
      const [job] = await db.insert(processingJobs).values({ captureId: first.captureId,
        idempotencyKey: 'second-synthetic-run', inputSha256: successful.capture.manifestSha256,
        processorVersion: processor.version, configuration: { processorId: processor.id },
      }).returning();
      assert.equal((await worker().runOnce(job.id)).state, 'processed');
      const [second] = await db.select().from(scanRevisions).where(eq(scanRevisions.processingJobId, job.id));
      assert.equal(second.revision, 2);
      assert.notEqual(second.id, first.id);
      assert.deepEqual(await readFile(path.join(outputRoot, first.id, 'scene.glb')), oldBytes);
      await assert.rejects(revisions.publish(path.join(outputRoot, first.id), first.id));
    });

    await t.test('processor and output-validation failures are persisted without revisions', async () => {
      const failure = await makeCapture();
      const failing: CaptureProcessor = { id: processor.id, version: processor.version,
        async process() { throw new ProcessingFailure('CPU_FAILED', 'Synthetic CPU failure'); } };
      await worker(failing).runOnce(failure.job.id);
      const saved = await readJob(db, owner, failure.job.id);
      assert.equal(saved.status, 'failed');
      assert.equal(saved.errorCode, 'CPU_FAILED');
      assert.equal((saved.errors[0] as { message: string }).message, 'Synthetic CPU failure');
      assert.equal(saved.revisionId, null);
      assert.ok(saved.completedAt);
      assert.equal((await worker().runOnce(failure.job.id)).state, 'idle');
      const incomplete = await makeCapture();
      const partial: CaptureProcessor = { id: processor.id, version: processor.version,
        async process({ inputDir, outputDir }) { await copyFile(path.join(inputDir, 'source.glb'), path.join(outputDir, 'master.glb')); } };
      await worker(partial).runOnce(incomplete.job.id);
      const rejected = await readJob(db, owner, incomplete.job.id);
      assert.equal(rejected.status, 'failed');
      assert.equal(rejected.errorCode, 'INVALID_OUTPUT');
      assert.equal(rejected.revisionId, null);
    });

    await t.test('SIGKILL leaves running work durable; another worker records interruption and recovers', async () => {
      const crashed = await makeCapture();
      const other = await makeCapture();
      child = spawn(process.execPath, ['--import', 'tsx', new URL('./fixtures/crash-worker.ts', import.meta.url).pathname], {
        env: { ...process.env, CAPTURE_TEST_STORAGE: inputRoot, REVISION_TEST_STORAGE: outputRoot, CAPTURE_TEST_JOB: crashed.job.id },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Crash worker did not reach processing')), 10000);
        let output = '';
        child!.stdout!.on('data', data => { output += data; if (output.includes('processor-started')) { clearTimeout(timer); resolve(); } });
        child!.once('error', error => { clearTimeout(timer); reject(error); });
        child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Crash worker exited before pause: ${code}`)); });
      });
      assert.equal((await readJob(db, owner, crashed.job.id)).status, 'running');
      assert.equal((await worker().runOnce(other.job.id)).state, 'busy');
      await assert.rejects(db.update(processingJobs).set({ status: 'running' }).where(eq(processingJobs.id, other.job.id)));
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      child = undefined;
      // A read after process death must not claim successful completion.
      assert.equal((await readJob(db, owner, crashed.job.id)).status, 'running');
      const resumed = await worker().runOnce(crashed.job.id);
      assert.equal(resumed.state, 'processed');
      const recovered = await readJob(db, owner, crashed.job.id);
      assert.equal(recovered.status, 'succeeded');
      assert.equal(recovered.attemptCount, 2);
      assert.equal((recovered.errors[0] as { code: string }).code, 'WORKER_INTERRUPTED');
      assert.equal((await db.select().from(scanRevisions).where(eq(scanRevisions.processingJobId, crashed.job.id))).length, 1);
      assert.equal((await worker().runOnce(other.job.id)).state, 'processed');
    });

    await t.test('repeated interruptions exhaust the retry budget with a saved failure', async () => {
      const exhausted = await makeCapture();
      await db.update(processingJobs).set({ status: 'running', attemptCount: 3,
        leaseToken: randomUUID(), leaseExpiresAt: new Date(),
      }).where(eq(processingJobs.id, exhausted.job.id));
      assert.equal((await worker().runOnce(exhausted.job.id)).state, 'idle');
      const job = await readJob(db, owner, exhausted.job.id);
      assert.equal(job.status, 'failed');
      assert.equal(job.errorCode, 'WORKER_INTERRUPTED');
      assert.equal(job.revisionId, null);
    });

    await t.test('crash after output promotion leaves no false success; recovery does not overwrite orphan bytes', async () => {
      const staged = await makeCapture();
      const before = new Set(await readdir(outputRoot));
      child = spawn(process.execPath, ['--import', 'tsx', new URL('./fixtures/crash-worker.ts', import.meta.url).pathname], {
        env: { ...process.env, CAPTURE_TEST_STORAGE: inputRoot, REVISION_TEST_STORAGE: outputRoot,
          CAPTURE_TEST_JOB: staged.job.id, CAPTURE_TEST_PAUSE: 'after-output' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker did not reach output promotion')), 10000);
        let output = '';
        child!.stdout!.on('data', data => { output += data; if (output.includes('outputs-written')) { clearTimeout(timer); resolve(); } });
        child!.once('error', error => { clearTimeout(timer); reject(error); });
        child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Worker exited before promotion: ${code}`)); });
      });
      const orphan = (await readdir(outputRoot)).find(name => !before.has(name))!;
      const original = await readFile(path.join(outputRoot, orphan, 'scene.glb'));
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; child = undefined;
      const pending = await readJob(db, owner, staged.job.id);
      assert.equal(pending.status, 'running');
      assert.equal(pending.revisionId, null);
      await worker().runOnce(staged.job.id);
      const recovered = await readJob(db, owner, staged.job.id);
      assert.equal(recovered.status, 'succeeded');
      assert.notEqual(recovered.revisionId, orphan);
      assert.deepEqual(await readFile(path.join(outputRoot, orphan, 'scene.glb')), original);
      assert.equal((await db.select().from(scanRevisions).where(eq(scanRevisions.processingJobId, staged.job.id))).length, 1);
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    if (spaceId) {
      await db.delete(scanRevisions).where(eq(scanRevisions.spaceId, spaceId));
      const ids = await db.select({ id: captures.id }).from(captures).where(eq(captures.spaceId, spaceId));
      if (ids.length) await db.delete(processingJobs).where(inArray(processingJobs.captureId, ids.map(row => row.id)));
      await db.delete(captures).where(eq(captures.spaceId, spaceId));
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    }
    if (ownerId) await db.delete(users).where(eq(users.id, ownerId));
    if (viewerId) await db.delete(users).where(eq(users.id, viewerId));
    await client.end();
    await rm(root, { recursive: true, force: true });
  }
});
