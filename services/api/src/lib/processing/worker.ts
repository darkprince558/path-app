import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { captures, processingJobs, scanRevisions } from '../../db/schema';
import { canonicalJson, captureManifest } from '../capture/contract';
import { captureObjectKey, type CaptureStorage } from '../storage/captures';
import type { RevisionStorage } from '../storage/revisions';
import { identityTransform } from '../api/scans';
import { ProcessingFailure, type CaptureProcessor } from './processor';

export const CAPTURE_WORKER_LOCK = 4042026;
const MAX_ATTEMPTS = 3;
type Job = typeof processingJobs.$inferSelect;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function errorMetadata(job: Job, code: string, message: string) {
  const previous = Array.isArray(job.metadata.errors) ? job.metadata.errors : [];
  return { ...job.metadata, errors: [...previous, { code, message, attempt: job.attemptCount,
    stage: job.stage, at: new Date().toISOString() }].slice(-20) };
}

export class CaptureWorker {
  constructor(private readonly options: {
    databaseUrl: string; captures: CaptureStorage; revisions: RevisionStorage; processor: CaptureProcessor;
    signal?: AbortSignal; heartbeatMs?: number; timeoutMs?: number;
  }) {}

  // Optional jobId is useful for targeted operational checks; the CLI drains FIFO by default.
  async runOnce(jobId?: string): Promise<{ state: 'busy' | 'idle' } | { state: 'processed'; jobId: string; status: 'succeeded' | 'failed' }> {
    const client = postgres(this.options.databaseUrl, { max: 1, prepare: false, idle_timeout: 0, max_lifetime: 0 });
    // This pool is private to one run, with one connection and no idle/lifetime recycling.
    // Use the full client so Drizzle retains postgres.js type parsers and transaction support.
    const connection = client;
    let locked = false;
    try {
      const [lock] = await connection`SELECT pg_try_advisory_lock(${CAPTURE_WORKER_LOCK}) AS acquired, pg_backend_pid() AS pid`;
      locked = lock.acquired;
      if (!locked) return { state: 'busy' };
      const pid = Number(lock.pid);
      const db = drizzle(connection);
      // Never steal work on lease expiry alone. This session lock proves no compliant worker owns it.
      const interrupted = await db.select().from(processingJobs).where(and(eq(processingJobs.status, 'running'), eq(processingJobs.jobType, 'capture')));
      for (const job of interrupted) {
        await db.update(processingJobs).set({
          status: job.attemptCount >= MAX_ATTEMPTS ? 'failed' : 'queued',
          stage: job.attemptCount >= MAX_ATTEMPTS ? 'failed' : 'recovered', progress: 0,
          leaseToken: null, leaseExpiresAt: null, errorCode: 'WORKER_INTERRUPTED',
          completedAt: job.attemptCount >= MAX_ATTEMPTS ? new Date() : null, updatedAt: new Date(),
          metadata: errorMetadata(job, 'WORKER_INTERRUPTED', 'Previous worker stopped before committing a result'),
        }).where(and(eq(processingJobs.id, job.id), sql`pg_backend_pid() = ${pid}`));
      }
      const job = await db.transaction(async tx => {
        const [queued] = await tx.select().from(processingJobs).where(and(
          eq(processingJobs.status, 'queued'), eq(processingJobs.jobType, 'capture'),
          jobId ? eq(processingJobs.id, jobId) : undefined,
        )).orderBy(asc(processingJobs.createdAt), asc(processingJobs.id)).limit(1).for('update', { skipLocked: true });
        if (!queued) return null;
        const [running] = await tx.update(processingJobs).set({ status: 'running', stage: 'preparing', progress: 5,
          attemptCount: queued.attemptCount + 1, leaseToken: randomUUID(),
          leaseExpiresAt: sql`now() + interval '30 seconds'`, heartbeatAt: new Date(),
          startedAt: queued.startedAt ?? new Date(), completedAt: null, updatedAt: new Date(),
        }).where(and(eq(processingJobs.id, queued.id), sql`pg_backend_pid() = ${pid}`)).returning();
        if (!running) throw new Error('Worker database session changed');
        return running;
      });
      if (!job) return { state: 'idle' };
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? 300_000),
        ...(this.options.signal ? [this.options.signal] : [])]);
      const guard = and(eq(processingJobs.id, job.id), eq(processingJobs.status, 'running'),
        eq(processingJobs.leaseToken, job.leaseToken!), sql`pg_backend_pid() = ${pid}`);
      let heartbeat: Promise<void> = Promise.resolve();
      const timer = setInterval(() => {
        heartbeat = heartbeat.then(async () => {
          const rows = await db.update(processingJobs).set({ heartbeatAt: new Date(),
            leaseExpiresAt: sql`now() + interval '30 seconds'`, updatedAt: new Date(),
          }).where(guard).returning({ id: processingJobs.id });
          if (!rows.length) throw new Error('Worker lease is no longer owned');
        }).catch(() => { controller.abort(new ProcessingFailure('WORKER_SESSION_LOST', 'Worker database session was lost')); });
      }, this.options.heartbeatMs ?? 5000);
      let work: string | undefined;
      let currentStage = job.stage;
      try {
        const setStage = async (stage: string, progress: number) => {
          signal.throwIfAborted();
          const rows = await db.update(processingJobs).set({ stage, progress, updatedAt: new Date() })
            .where(guard).returning({ id: processingJobs.id });
          if (!rows.length) throw new ProcessingFailure('WORKER_SESSION_LOST', 'Worker no longer owns this job');
          currentStage = stage;
        };
        const processor = this.options.processor;
        if (job.processorVersion !== processor.version || job.configuration.processorId !== processor.id) {
          throw new ProcessingFailure('PROCESSOR_UNAVAILABLE', 'Queued processor version is not available in this worker');
        }
        const [capture] = await db.select().from(captures).where(eq(captures.id, job.captureId));
        if (!capture || capture.status !== 'uploaded' || capture.manifestSha256 !== job.inputSha256) {
          throw new ProcessingFailure('INVALID_INPUT', 'Capture is not finalized or its input digest changed');
        }
        const manifest = captureManifest.parse(capture.manifest);
        const manifestBytes = Buffer.from(canonicalJson(manifest));
        if (hash(manifestBytes) !== job.inputSha256) throw new ProcessingFailure('INVALID_INPUT', 'Manifest digest changed');
        work = await mkdtemp(path.join(tmpdir(), 'not404-processing-'));
        const inputDir = path.join(work, 'input'), outputDir = path.join(work, 'output');
        await mkdir(inputDir, { mode: 0o700 });
        await mkdir(outputDir, { mode: 0o700 });
        for (const file of [{ path: 'manifest.json', byteSize: manifestBytes.length, sha256: job.inputSha256 }, ...manifest.files]) {
          signal.throwIfAborted();
          let bytes: Uint8Array;
          try { bytes = await this.options.captures.read(captureObjectKey(capture.id, file.path), file.byteSize); }
          catch { throw new ProcessingFailure('INVALID_INPUT', 'Capture file is missing or exceeds its declared size'); }
          if (bytes.length !== file.byteSize || hash(bytes) !== file.sha256) throw new ProcessingFailure('INVALID_INPUT', 'Capture file checksum changed');
          const destination = path.join(inputDir, file.path);
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        }
        await setStage('processing', 25);
        await processor.process({ inputDir, outputDir, signal });
        signal.throwIfAborted();
        await setStage('validating', 80);
        const revisionId = randomUUID();
        const outputs = await this.options.revisions.publish(outputDir, revisionId);
        signal.throwIfAborted();
        await db.transaction(async tx => {
          const [current] = await tx.select().from(processingJobs).where(guard).for('update');
          if (!current) throw new ProcessingFailure('WORKER_SESSION_LOST', 'Worker no longer owns this job');
          await tx.select({ id: captures.id }).from(captures).where(eq(captures.id, capture.id)).for('update');
          const [latest] = await tx.select({ number: sql<number>`coalesce(max(${scanRevisions.revision}), 0)` })
            .from(scanRevisions).where(eq(scanRevisions.captureId, capture.id));
          const scene = outputs.files.find(file => file.path === 'scene.glb');
          if (!scene) throw new ProcessingFailure('INVALID_OUTPUT', 'Scene output is missing');
          await tx.insert(scanRevisions).values({ id: revisionId, captureId: capture.id, spaceId: capture.spaceId,
            processingJobId: job.id, revision: Number(latest.number) + 1, objectKey: scene.objectKey,
            outputSha256: scene.sha256, transform: identityTransform,
            metadata: { files: outputs.files, report: outputs.report, processor: { id: processor.id, version: processor.version },
              inputSha256: job.inputSha256, alignmentVerified: false, coordinateSystem: manifest.coordinateSystem },
          });
          const rows = await tx.update(processingJobs).set({ status: 'succeeded', stage: 'complete', progress: 100,
            completedAt: new Date(), leaseToken: null, leaseExpiresAt: null, errorCode: null, updatedAt: new Date(),
          }).where(guard).returning({ id: processingJobs.id });
          if (!rows.length) throw new ProcessingFailure('WORKER_SESSION_LOST', 'Worker lost ownership before commit');
        });
        return { state: 'processed', jobId: job.id, status: 'succeeded' };
      } catch (error) {
        const code = error instanceof ProcessingFailure ? error.code : signal.aborted ? 'PROCESSING_ABORTED' : 'PROCESSOR_FAILED';
        const message = error instanceof ProcessingFailure ? error.message : 'Capture processing failed before a valid revision was committed';
        const rows = await db.update(processingJobs).set({ status: 'failed', stage: 'failed', errorCode: code,
          metadata: errorMetadata({ ...job, stage: currentStage }, code, message), completedAt: new Date(), updatedAt: new Date(),
          leaseToken: null, leaseExpiresAt: null,
        }).where(guard).returning({ id: processingJobs.id });
        if (!rows.length) throw new Error('Worker lost ownership; job remains durable for recovery');
        return { state: 'processed', jobId: job.id, status: 'failed' };
      } finally {
        clearInterval(timer);
        await heartbeat;
        if (work) await rm(work, { recursive: true, force: true });
      }
    } finally {
      try { if (locked) await connection`SELECT pg_advisory_unlock(${CAPTURE_WORKER_LOCK})`; }
      finally { await client.end(); }
    }
  }
}
