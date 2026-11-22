import { randomUUID, createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { connectDatabase } from '../../db/client';
import { captures, navNodes, processingJobs, scanRevisions, scans, spaces } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import type { ScanStorage } from '../storage';
import type { RevisionStorage } from '../storage/revisions';
import { canonicalJson, captureManifest } from '../capture/contract';
import { metricCoordinates, metricSpace, preservesMetricFrame, validatedMetricCapture } from '../processing/calibration';
import { badRequest, conflict, notFound } from './http';
import { name, uuid, visibility } from './validation';
import { effectiveScanCalibration, scanResponse, transform, validateGlb } from './scans';

const coordinateSystem = z.object({ units: z.enum(['metres', 'relative']), upAxis: z.literal('Y'), calibrated: z.boolean() }).strict();
export const approvalInput = z.object({ name, visibility: visibility.default('private'),
  transform: transform.optional(), coordinateSystem: coordinateSystem.optional(),
  alignmentVerified: z.boolean().optional(),
}).strict();
const outputFile = z.object({ path: z.enum(['master.glb', 'scene.glb', 'scene.ply', 'preview.jpg', 'report.json']),
  objectKey: z.string(), byteSize: z.number().int().positive().max(32 * 1024 * 1024),
  sha256: z.string().length(64).regex(/^[0-9a-f]{64}$/),
}).strict();

export function revisionFiles(revision: typeof scanRevisions.$inferSelect) {
  const parsed = z.array(outputFile).min(4).max(5).safeParse(revision.metadata.files);
  if (!parsed.success) throw conflict('Revision output inventory is invalid');
  const files = parsed.data;
  if (new Set(files.map(file => file.path)).size !== files.length ||
      ['master.glb', 'scene.glb', 'preview.jpg', 'report.json'].some(path => !files.some(file => file.path === path)) ||
      files.some(file => file.objectKey !== `revisions/${revision.id}/${file.path}`)) throw conflict('Revision output references are invalid');
  const scene = files.find(file => file.path === 'scene.glb')!;
  if (scene.objectKey !== revision.objectKey || scene.sha256 !== revision.outputSha256) throw conflict('Revision scene digest is inconsistent');
  return files;
}

export async function revisionBytes(storage: RevisionStorage, revision: typeof scanRevisions.$inferSelect, filename: string) {
  const file = revisionFiles(revision).find(file => file.path === filename);
  if (!file) throw notFound();
  try { return await storage.readVerified(revision.id, file.path, file); }
  catch { throw conflict('Revision output is missing, unsafe or corrupt'); }
}

export async function approveRevision(db: ReturnType<typeof connectDatabase>['db'], storage: ScanStorage,
  revisions: RevisionStorage, user: AppUser, revisionId: string, value: unknown) {
  const input = approvalInput.parse(value);
  let newKey: string | undefined;
  try {
    return await db.transaction(async tx => {
      const [row] = await tx.select({ revision: scanRevisions, capture: captures, job: processingJobs, space: spaces })
        .from(scanRevisions).innerJoin(captures, eq(captures.id, scanRevisions.captureId))
        .innerJoin(processingJobs, eq(processingJobs.id, scanRevisions.processingJobId))
        .innerJoin(spaces, eq(spaces.id, scanRevisions.spaceId))
        .where(eq(scanRevisions.id, uuid.parse(revisionId))).for('update', { of: scanRevisions });
      if (!row || row.space.ownerId !== user.id || row.capture.ownerId !== user.id) throw notFound();
      const { revision, capture, job, space } = row;
      if (!['draft', 'approved'].includes(revision.status) || job.status !== 'succeeded' || !job.completedAt ||
          capture.status !== 'uploaded' || capture.spaceId !== space.id || job.captureId !== capture.id ||
          job.inputSha256 !== capture.manifestSha256) throw conflict('Only a completed successful revision can be approved');
      const [existing] = await tx.select().from(scans).where(eq(scans.sourceRevisionId, revision.id));
      if (existing) {
        if (revision.status !== 'approved') throw conflict('Revision approval has been withdrawn');
        return { scan: scanResponse(await effectiveScanCalibration(tx, existing)), created: false, sharePath: `/s/${existing.shareId}` };
      }
      if (input.visibility === 'public' && space.visibility !== 'public') throw badRequest('A public scan requires a public space');
      await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, space.id)).for('update');
      const files = revisionFiles(revision);
      let scene: Uint8Array | undefined;
      for (const file of files) {
        const bytes = await revisionBytes(revisions, revision, file.path);
        if (file.path === 'scene.glb') scene = bytes;
      }
      if (!scene) throw conflict('Revision scene is missing');
      validateGlb(scene, 'scene.glb');
      const matrix = input.transform ?? transform.parse(revision.transform);
      const manifest = captureManifest.parse(capture.manifest);
      const metric = createHash('sha256').update(canonicalJson(manifest)).digest('hex') === job.inputSha256 &&
        validatedMetricCapture(manifest, revision.metadata.report as Record<string, unknown> ?? {},
          { id: job.configuration.processorId, version: job.processorVersion }, job.inputSha256) && preservesMetricFrame(matrix);
      const frame = coordinateSystem.safeParse(revision.metadata.coordinateSystem);
      const coordinates = input.coordinateSystem ?? (metric ? metricCoordinates : {
        units: frame.success ? frame.data.units : (revision.metadata.coordinateSystem as { units?: unknown })?.units === 'metres' ? 'metres' as const : 'relative' as const,
        upAxis: 'Y' as const, calibrated: false,
      });
      const [otherScan] = await tx.select({ id: scans.id }).from(scans).where(and(eq(scans.spaceId, space.id), eq(scans.status, 'ready'), eq(scans.format, 'glb'))).limit(1);
      const [node] = await tx.select({ id: navNodes.id }).from(navNodes).where(eq(navNodes.spaceId, space.id)).limit(1);
      const declared = space.boundary?.coordinateSystem as { units?: string; calibrated?: boolean } | undefined;
      const spaceUnits = declared?.units === 'metres' && declared.calibrated === true ? 'metres' : 'relative';
      const automaticAlignment = metric && metricSpace(space.boundary) && coordinates.units === 'metres' && coordinates.calibrated && !otherScan && !node;
      const alignmentVerified = input.alignmentVerified ?? automaticAlignment;
      if (node && (!alignmentVerified || coordinates.units !== spaceUnits || (spaceUnits === 'metres' && !coordinates.calibrated))) {
        throw conflict('Confirm alignment and matching space units before adding a model to an existing navigation graph');
      }
      const id = randomUUID(); newKey = `scans/${id}.glb`;
      await storage.put(newKey, scene);
      const now = new Date();
      const [scan] = await tx.insert(scans).values({ id, sourceRevisionId: revision.id, ownerId: user.id,
        spaceId: space.id, name: input.name, visibility: input.visibility, format: 'glb', status: 'ready',
        objectKey: newKey, byteSize: scene.length, transform: matrix,
        metadata: { coordinateSystem: coordinates, alignmentVerified, alignmentSource: input.alignmentVerified === true ? 'owner' : automaticAlignment && alignmentVerified ? 'single-capture' : 'unverified',
          processing: { processorId: job.configuration.processorId, processorVersion: job.processorVersion,
            mock: (revision.metadata.report as { mock?: boolean } | undefined)?.mock === true } },
      }).returning();
      await tx.update(scanRevisions).set({ status: 'approved', approvedBy: user.id,
        approvedAt: revision.approvedAt ?? now, updatedAt: now }).where(eq(scanRevisions.id, revision.id));
      return { scan: scanResponse(scan), created: true, sharePath: `/s/${scan.shareId}` };
    });
  } catch (error) {
    if (newKey) {
      // A lost COMMIT response is ambiguous. Never remove bytes if a scan may have committed.
      try {
        const [persisted] = await db.select({ id: scans.id }).from(scans).where(eq(scans.objectKey, newKey));
        if (!persisted) await storage.delete(newKey).catch(() => {});
      } catch { /* Leave a private orphan rather than damage a possibly committed scan. */ }
    }
    throw error;
  }
}
