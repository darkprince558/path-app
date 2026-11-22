import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { connectDatabase } from '../../db/client';
import { captureFrames, captures, scanRevisions, scans } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import type { ScanStorage } from '../storage';
import { captureObjectKey, type CaptureStorage } from '../storage/captures';
import type { RevisionStorage } from '../storage/revisions';
import { captureManifest } from '../capture/contract';
import { digestBytes } from './captures';
import { canReadScan, downloadScan, effectiveScanCalibration, transform } from './scans';
import { revisionBytes, revisionFiles } from './revision-approval';
import { conflict, notFound } from './http';
import { cachedAsset, etagFor } from './http-cache';
import { uuid } from './validation';

type Db = ReturnType<typeof connectDatabase>['db'];
export async function readShare(db: Db, user: AppUser | null, shareId: string) {
  const [scan] = await db.select().from(scans).where(eq(scans.shareId, uuid.parse(shareId)));
  if (!scan || scan.status !== 'ready' || !(await canReadScan(db, user, scan))) throw notFound();
  return effectiveScanCalibration(db, scan);
}

export async function shareMetadata(db: Db, user: AppUser | null, shareId: string) {
  const scan = await readShare(db, user, shareId);
  let pointsPath: string | null = null;
  if (scan.sourceRevisionId) {
    const [revision] = await db.select().from(scanRevisions).where(eq(scanRevisions.id, scan.sourceRevisionId));
    if (revisionFiles(revision).some(file => file.path === 'scene.ply')) pointsPath = `/api/shares/${scan.shareId}/points`;
  }
  const coordinates = z.object({ units: z.enum(['metres', 'relative']), upAxis: z.literal('Y'),
    calibrated: z.boolean().optional() }).safeParse(scan.metadata.coordinateSystem);
  return { shareId: scan.shareId, sharePath: `/s/${scan.shareId}`, scanId: scan.id, spaceId: scan.spaceId,
    revisionId: scan.sourceRevisionId, name: scan.name, format: scan.format,
    assetPath: `/api/shares/${scan.shareId}/scene`, scenePath: `/api/shares/${scan.shareId}/scene`, pointsPath,
    transform: transform.parse(scan.transform), metadata: { alignmentVerified: scan.metadata.alignmentVerified === true,
      ...(coordinates.success ? { coordinateSystem: coordinates.data } : {}) },
  };
}

export async function shareScene(db: Db, storage: ScanStorage, user: AppUser | null, shareId: string) {
  const scan = await readShare(db, user, shareId);
  return (await downloadScan(db, storage, user, scan.id)).bytes;
}

export async function sharePoints(db: Db, revisions: RevisionStorage, user: AppUser | null, shareId: string) {
  const scan = await readShare(db, user, shareId);
  if (!scan.sourceRevisionId) throw notFound();
  const [revision] = await db.select().from(scanRevisions).where(eq(scanRevisions.id, scan.sourceRevisionId));
  return revisionBytes(revisions, revision, 'scene.ply');
}

/**
 * The share's model, cacheable by the browser. Access is checked first (readShare); a repeat
 * open with the current ETag gets a 304 without reading or re-hashing the file. A scan's
 * object key is unique to its bytes (new uploads and approvals write new keys).
 */
export async function shareSceneResponse(request: Request, db: Db, storage: ScanStorage, user: AppUser | null, shareId: string) {
  const scan = await readShare(db, user, shareId);
  const etag = etagFor('scene', scan.id, scan.objectKey, scan.byteSize, scan.sourceRevisionId);
  return cachedAsset(request, etag, 'model/gltf-binary', async () => (await downloadScan(db, storage, user, scan.id)).bytes);
}

/** The approved revision's point cloud, cacheable like the model. Revision outputs never change. */
export async function sharePointsResponse(request: Request, db: Db, revisions: RevisionStorage, user: AppUser | null, shareId: string) {
  const scan = await readShare(db, user, shareId);
  if (!scan.sourceRevisionId) throw notFound();
  const [revision] = await db.select().from(scanRevisions).where(eq(scanRevisions.id, scan.sourceRevisionId));
  const file = revision ? revisionFiles(revision).find(entry => entry.path === 'scene.ply') : undefined;
  if (!revision || !file) throw notFound();
  return cachedAsset(request, etagFor('points', revision.id, file.sha256, file.byteSize), 'application/ply',
    () => revisionBytes(revisions, revision, 'scene.ply'));
}

export async function shareFrame(db: Db, storage: CaptureStorage, user: AppUser | null, shareId: string, frameId: string) {
  const scan = await readShare(db, user, shareId);
  // Scan-viewer grants and public access never imply access to original camera images.
  if (scan.ownerId !== user?.id || !scan.sourceRevisionId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(frameId) || frameId !== frameId.trim()) throw notFound();
  const [revision] = await db.select().from(scanRevisions).where(eq(scanRevisions.id, scan.sourceRevisionId));
  const [frame] = await db.select().from(captureFrames).where(and(eq(captureFrames.captureId, revision.captureId), eq(captureFrames.frameId, frameId)));
  if (!frame) throw notFound();
  const [capture] = await db.select().from(captures).where(eq(captures.id, revision.captureId));
  const manifest = captureManifest.parse(capture.manifest);
  const key = captureObjectKey(capture.id, `frames/${frameId}.jpg`);
  const expected = manifest.files.find(file => file.path === `frames/${frameId}.jpg`);
  if (!expected || frame.objectKey !== key || frame.sha256 !== expected.sha256) throw conflict('Frame reference is inconsistent');
  try {
    const bytes = await storage.read(key, expected.byteSize);
    const actual = digestBytes(bytes);
    if (actual.byteSize !== expected.byteSize || actual.sha256 !== expected.sha256) throw new Error('Frame digest mismatch');
    return bytes;
  } catch { throw conflict('Frame is missing, unsafe or corrupt'); }
}

export function privateAsset(bytes: Uint8Array, contentType: string) {
  return new Response(Uint8Array.from(bytes), { headers: { 'Content-Type': contentType,
    'Content-Length': String(bytes.byteLength), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
