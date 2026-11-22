import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { connectDatabase } from '../../db/client';
import { captures, navNodes, processingJobs, scanRevisions, scans, spaces } from '../../db/schema';
import { requireOwner } from '../auth/authorization';
import type { AppUser } from '../auth/user-sync';
import { canonicalJson, captureManifest } from '../capture/contract';
import { metricCoordinates, metricSpace, preservesMetricFrame, validatedMetricCapture } from '../processing/calibration';
import { conflict } from './http';
import { effectiveScanCalibration, readScan, scanResponse } from './scans';

/** Explicit owner repair for old approvals. Re-derive from immutable provenance, never from alignmentVerified. */
export async function restoreCaptureCalibration(db: ReturnType<typeof connectDatabase>['db'], user: AppUser, id: string) {
  const scan = await readScan(db, user, id);
  requireOwner(user, scan.ownerId);
  if (!scan.sourceRevisionId) throw conflict('This imported model has no validated LiDAR provenance. Verify its measured scale in Owner tools.');
  const [row] = await db.select({ revision: scanRevisions, capture: captures, job: processingJobs, space: spaces })
    .from(scanRevisions).innerJoin(captures, eq(captures.id, scanRevisions.captureId))
    .innerJoin(processingJobs, eq(processingJobs.id, scanRevisions.processingJobId))
    .innerJoin(spaces, eq(spaces.id, scanRevisions.spaceId)).where(eq(scanRevisions.id, scan.sourceRevisionId));
  const manifest = captureManifest.safeParse(row?.capture.manifest);
  if (!row || !manifest.success || createHash('sha256').update(canonicalJson(manifest.data)).digest('hex') !== row.job.inputSha256 ||
      !validatedMetricCapture(manifest.data, row.revision.metadata.report as Record<string, unknown> ?? {},
        { id: row.job.configuration.processorId, version: row.job.processorVersion }, row.job.inputSha256)) {
    throw conflict('No validated metric ARKit provenance. Mock, synthetic and unknown-scale scans require explicit owner scale verification.');
  }
  if (!preservesMetricFrame(scan.transform) || !metricSpace(row.space.boundary)) {
    throw conflict('Restore a unit-scale Y-up transform and calibrated metric space, or explicitly verify the transformed scale in Owner tools.');
  }
  const siblings = await db.select({ id: scans.id }).from(scans).where(and(eq(scans.spaceId, scan.spaceId), eq(scans.status, 'ready'), eq(scans.format, 'glb'))).limit(2);
  const [node] = await db.select({ id: navNodes.id }).from(navNodes).where(eq(navNodes.spaceId, scan.spaceId)).limit(1);
  const auto = siblings.length === 1 && !node;
  const verified = scan.metadata.alignmentVerified === true;
  const [updated] = await db.update(scans).set({ metadata: { ...scan.metadata,
    coordinateSystem: metricCoordinates, alignmentVerified: verified || auto,
    alignmentSource: verified ? scan.metadata.alignmentSource ?? 'owner' : auto ? 'single-capture' : 'unverified',
  }, updatedAt: new Date() }).where(eq(scans.id, scan.id)).returning();
  return scanResponse(await effectiveScanCalibration(db, updated));
}
