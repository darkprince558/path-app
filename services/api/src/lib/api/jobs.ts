import { and, eq } from 'drizzle-orm';
import type { connectDatabase } from '../../db/client';
import { captures, processingJobs, scanRevisions, spaces } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import { notFound } from './http';
import { uuid } from './validation';

export async function readJob(db: ReturnType<typeof connectDatabase>['db'], user: AppUser, id: string) {
  const [row] = await db.select({ job: processingJobs }).from(processingJobs)
    .innerJoin(captures, eq(captures.id, processingJobs.captureId))
    .innerJoin(spaces, eq(spaces.id, captures.spaceId))
    .where(and(eq(processingJobs.id, uuid.parse(id)), eq(captures.ownerId, user.id), eq(spaces.ownerId, user.id)));
  if (!row) throw notFound();
  const { job } = row;
  const [revision] = await db.select({ id: scanRevisions.id }).from(scanRevisions)
    .where(eq(scanRevisions.processingJobId, job.id));
  return { id: job.id, captureId: job.captureId, status: job.status, stage: job.stage,
    progress: job.progress, attemptCount: job.attemptCount, processorVersion: job.processorVersion,
    processorId: typeof job.configuration.processorId === 'string' ? job.configuration.processorId : null,
    errorCode: job.errorCode, errors: Array.isArray(job.metadata.errors) ? job.metadata.errors : [],
    revisionId: revision?.id ?? null, createdAt: job.createdAt, startedAt: job.startedAt,
    heartbeatAt: job.heartbeatAt, completedAt: job.completedAt, updatedAt: job.updatedAt };
}
