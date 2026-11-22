import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { connectDatabase } from '../../db/client';
import { captures, captureFrames, spaces } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import { requireOwner } from '../auth/authorization';
import {
  canonicalJson, captureManifest, capturePath, captureRegistration, MAX_CAPTURE_JSON_BYTES,
  validateFrameReferences, type FileDigest,
} from '../capture/contract';
import { captureObjectKey, CaptureIntegrityError, type CaptureStorage } from '../storage/captures';
import { readSpace } from './access';
import { ApiError, badRequest, conflict, notFound } from './http';
import { uuid } from './validation';
import { enqueueCapture } from '../processing/queue';

type Db = ReturnType<typeof connectDatabase>['db'];
type Capture = typeof captures.$inferSelect;
export const digestBytes = (bytes: Uint8Array): FileDigest => ({
  byteSize: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
});
export async function* byteChunks(bytes: Uint8Array) { yield bytes; }

export async function* requestChunks(request: Request) {
  if (!request.body) throw badRequest('A file body is required');
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function parseCaptureJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw badRequest('Valid UTF-8 JSON is required'); }
}

export async function boundedCaptureJson(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw badRequest('application/json is required');
  }
  const length = Number(request.headers.get('content-length'));
  if (length > MAX_CAPTURE_JSON_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Capture JSON exceeds 2 MiB');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of requestChunks(request)) {
    size += chunk.byteLength;
    if (size > MAX_CAPTURE_JSON_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Capture JSON exceeds 2 MiB');
    chunks.push(chunk);
  }
  return parseCaptureJson(Buffer.concat(chunks, size));
}

function captureResponse(capture: Capture) {
  return { id: capture.id, spaceId: capture.spaceId, deviceCaptureId: capture.deviceCaptureId,
    status: capture.status, manifestSha256: capture.manifestSha256,
    trackingWarnings: capture.trackingWarnings, createdAt: capture.createdAt, uploadedAt: capture.uploadedAt };
}

async function verifiedPut(storage: CaptureStorage, key: string, chunks: AsyncIterable<Uint8Array>, digest: FileDigest) {
  try { await storage.putVerified(key, chunks, digest); }
  catch (error) {
    if (error instanceof CaptureIntegrityError) throw badRequest(error.message);
    throw error;
  }
}

export async function registerCapture(db: Db, storage: CaptureStorage, user: AppUser, value: unknown) {
  const { spaceId, manifest } = captureRegistration.parse(value);
  const space = await readSpace(db, user, spaceId);
  requireOwner(user, space.ownerId);
  const bytes = Buffer.from(canonicalJson(manifest));
  if (bytes.byteLength > MAX_CAPTURE_JSON_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Manifest exceeds 2 MiB');
  const digest = digestBytes(bytes);
  return db.transaction(async tx => {
    const id = randomUUID();
    const [inserted] = await tx.insert(captures).values({
      id, ownerId: user.id, spaceId, deviceCaptureId: manifest.captureId,
      manifestVersion: manifest.version, manifest, manifestSha256: digest.sha256,
      bundleObjectPrefix: `captures/${id}`, device: manifest.device,
      coordinateSystem: manifest.coordinateSystem, entrancePose: manifest.entrancePose,
      trackingWarnings: manifest.trackingWarnings,
      capturedAt: manifest.capturedAt ? new Date(manifest.capturedAt) : null,
    }).onConflictDoNothing({ target: [captures.ownerId, captures.deviceCaptureId] }).returning();
    const capture = inserted ?? (await tx.select().from(captures).where(and(
      eq(captures.ownerId, user.id), eq(captures.deviceCaptureId, manifest.captureId),
    )).for('update'))[0];
    if (!capture || capture.manifestSha256 !== digest.sha256 || capture.spaceId !== spaceId) {
      throw conflict('Capture ID is already registered with a different manifest or space');
    }
    if (!['uploading', 'uploaded'].includes(capture.status)) throw conflict('Capture is not accepting uploads');
    await verifiedPut(storage, captureObjectKey(capture.id, 'manifest.json'), byteChunks(bytes), digest);
    return { capture: captureResponse(capture), created: !!inserted };
  });
}

// A row lock serializes uploads/finalize for one capture, including across API processes.
async function lockedCapture(db: Pick<Db, 'select'>, user: AppUser, id: string) {
  const [row] = await db.select({ capture: captures }).from(captures)
    .innerJoin(spaces, and(eq(spaces.id, captures.spaceId), eq(spaces.ownerId, user.id)))
    .where(and(eq(captures.id, uuid.parse(id)), eq(captures.ownerId, user.id)))
    .for('update', { of: captures });
  if (!row) throw notFound();
  return row.capture;
}

export async function uploadCaptureFile(db: Db, storage: CaptureStorage, user: AppUser, id: string, request: Request) {
  return db.transaction(async tx => {
    const capture = await lockedCapture(tx, user, id);
    if (capture.status !== 'uploading') throw conflict('Capture is immutable after finalization');
    const query = new URL(request.url).searchParams;
    if (query.getAll('path').length !== 1 || [...query.keys()].some(key => key !== 'path')) {
      throw badRequest('Exactly one path query parameter is required');
    }
    const filePath = capturePath.parse(query.get('path'));
    const manifest = captureManifest.parse(capture.manifest);
    const file = manifest.files.find(item => item.path === filePath);
    if (!file) throw badRequest('File is not declared in the manifest');
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
      throw badRequest('application/octet-stream is required');
    }
    const length = request.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== file.byteSize)) {
      throw badRequest('Content-Length does not match manifest');
    }
    // JSON is small and bounded; validate references before accepting this immutable file.
    let chunks: AsyncIterable<Uint8Array> = requestChunks(request);
    if (filePath === 'frames.json') {
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > file.byteSize) throw badRequest('frames.json exceeds declared size');
        parts.push(chunk);
      }
      const bytes = Buffer.concat(parts, size);
      validateFrameReferences(parseCaptureJson(bytes), manifest);
      chunks = byteChunks(bytes);
    }
    await verifiedPut(storage, captureObjectKey(capture.id, filePath), chunks, file);
    await tx.update(captures).set({ updatedAt: new Date() }).where(eq(captures.id, capture.id));
    return { captureId: capture.id, path: filePath, byteSize: file.byteSize, sha256: file.sha256 };
  });
}

export async function finalizeCapture(db: Db, storage: CaptureStorage, user: AppUser, id: string) {
  return db.transaction(async tx => {
    const capture = await lockedCapture(tx, user, id);
    if (capture.status === 'uploaded') return { capture: captureResponse(capture), job: await enqueueCapture(tx, capture) };
    if (capture.status !== 'uploading') throw conflict('Capture cannot be finalized');
    const manifest = captureManifest.parse(capture.manifest);
    const expectedManifest = digestBytes(Buffer.from(canonicalJson(manifest)));
    if (expectedManifest.sha256 !== capture.manifestSha256) throw conflict('Stored manifest is inconsistent');
    const invalid: string[] = [];
    for (const file of [{ path: 'manifest.json', ...expectedManifest }, ...manifest.files]) {
      const actual = await storage.inspect(captureObjectKey(capture.id, file.path));
      if (!actual || actual.byteSize !== file.byteSize || actual.sha256 !== file.sha256) invalid.push(file.path);
    }
    if (invalid.length) throw conflict(`Missing or corrupt files: ${invalid.join(', ')}`);
    const index = validateFrameReferences(parseCaptureJson(await storage.read(
      captureObjectKey(capture.id, 'frames.json'), MAX_CAPTURE_JSON_BYTES,
    )), manifest);
    await tx.insert(captureFrames).values(index.frames.map(frame => ({
      captureId: capture.id, frameId: frame.id,
      objectKey: captureObjectKey(capture.id, frame.imagePath),
      sha256: manifest.files.find(file => file.path === frame.imagePath)!.sha256,
      cameraPose: frame.cameraPose, intrinsics: frame.intrinsics,
      timestampSeconds: frame.timestampSeconds, width: frame.width, height: frame.height,
    })));
    const [uploaded] = await tx.update(captures).set({
      status: 'uploaded', uploadedAt: new Date(), updatedAt: new Date(),
    }).where(eq(captures.id, capture.id)).returning();
    return { capture: captureResponse(uploaded), job: await enqueueCapture(tx, uploaded) };
  });
}
