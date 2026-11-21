import { and, eq } from 'drizzle-orm';
import type { connectDatabase } from '../../db/client';
import { captures, processingJobs } from '../../db/schema';
import { DEFAULT_PROCESSOR } from './processor';

type Db = ReturnType<typeof connectDatabase>['db'];
export function queuedJobResponse(job: typeof processingJobs.$inferSelect) {
  return { id: job.id, status: job.status, statusPath: `/api/jobs/${job.id}` };
}

// Called in the same transaction as capture finalization, under its existing row lock.
export async function enqueueCapture(db: Pick<Db, 'insert' | 'select'>, capture: typeof captures.$inferSelect) {
  const key = 'initial-processing-v1';
  const [inserted] = await db.insert(processingJobs).values({
    captureId: capture.id, jobType: 'capture', idempotencyKey: key,
    inputSha256: capture.manifestSha256, processorVersion: DEFAULT_PROCESSOR.version,
    configuration: { processorId: DEFAULT_PROCESSOR.id },
  }).onConflictDoNothing({ target: [processingJobs.captureId, processingJobs.idempotencyKey] }).returning();
  const job = inserted ?? (await db.select().from(processingJobs).where(and(
    eq(processingJobs.captureId, capture.id), eq(processingJobs.idempotencyKey, key),
  )))[0];
  if (!job || job.inputSha256 !== capture.manifestSha256) throw new Error('Inconsistent capture job input');
  return queuedJobResponse(job);
}
