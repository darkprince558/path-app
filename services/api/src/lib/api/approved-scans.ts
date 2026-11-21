import { and, eq } from 'drizzle-orm';
import type { connectDatabase } from '../../db/client';
import { captures, processingJobs, scanRevisions, scans } from '../../db/schema';

// Kept separate from scan services to avoid a dependency cycle with approval/sharing.
export async function isApprovedScan(db: Pick<ReturnType<typeof connectDatabase>['db'], 'select'>,
  scan: typeof scans.$inferSelect) {
  if (!scan.sourceRevisionId) return true; // Preserve manual GLB uploads and legacy records.
  const [row] = await db.select({ revision: scanRevisions, capture: captures, job: processingJobs })
    .from(scanRevisions).innerJoin(captures, eq(captures.id, scanRevisions.captureId))
    .innerJoin(processingJobs, eq(processingJobs.id, scanRevisions.processingJobId))
    .where(and(eq(scanRevisions.id, scan.sourceRevisionId), eq(scanRevisions.spaceId, scan.spaceId)));
  return !!row && row.revision.status === 'approved' && !!row.revision.approvedAt &&
    row.revision.approvedBy === row.capture.ownerId && row.capture.ownerId === scan.ownerId &&
    row.capture.spaceId === scan.spaceId && row.capture.status === 'uploaded' && row.job.status === 'succeeded' &&
    !!row.job.completedAt && row.job.captureId === row.capture.id && row.job.inputSha256 === row.capture.manifestSha256;
}
