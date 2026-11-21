import { and, eq } from 'drizzle-orm';
import type { connectDatabase } from '../../db/client';
import { captures, processingJobs } from '../../db/schema';
import { selectedProcessor } from './selection';

type Db = ReturnType<typeof connectDatabase>['db'];
export function queuedJobResponse(job: typeof processingJobs.$inferSelect) {
  return { id: job.id, status: job.status, statusPath: `/api/jobs/${job.id}` };
}

// Called in the same transaction as capture finalization, under its existing row lock.
export async function enqueueCapture(db: Pick<Db, 'insert' | 'select'>, capture: typeof captures.$inferSelect) {
  const key = 'initial-processing-v1';
  const processor = selectedProcessor();
  const [inserted] = await db.insert(processingJobs).values({
    captureId: capture.id, jobType: 'capture', idempotencyKey: key,
    inputSha256: capture.manifestSha256, processorVersion: processor.version,
    configuration: { processorId: processor.id },
  }).onConflictDoNothing({ target: [processingJobs.captureId, processingJobs.idempotencyKey] }).returning();
  const job = inserted ?? (await db.select().from(processingJobs).where(and(
    eq(processingJobs.captureId, capture.id), eq(processingJobs.idempotencyKey, key),
  )))[0];
  if (!job || job.inputSha256 !== capture.manifestSha256) throw new Error('Inconsistent capture job input');
  return queuedJobResponse(job);
}
