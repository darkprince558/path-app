import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { connectDatabase } from '../../db/client';
import { scans, scanViewers, spaces } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import { requireOwner } from '../auth/authorization';
import type { ScanStorage } from '../storage';
import { canReadSpace, readSpace } from './access';
import { ApiError, badRequest, conflict, notFound } from './http';
import { metadata, name, uuid, visibility } from './validation';

type Db = ReturnType<typeof connectDatabase>['db'];
type Scan = typeof scans.$inferSelect;
export const MAX_GLB_BYTES = 32 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_GLB_BYTES + 1024 * 1024;
export const identityTransform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const transform = z.array(z.number().finite()).length(16);
export const scanInput = z.object({
  name, visibility: visibility.optional(), transform,
  metadata: metadata.optional(),
}).strict();
export const scanPatch = scanInput.partial();

// Limit the complete multipart body before Request.formData() buffers/parses it.
export async function boundedFormData(request: Request): Promise<FormData> {
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) throw badRequest('multipart/form-data is required');
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_MULTIPART_BYTES) throw new PayloadTooLarge();
  if (!request.body) throw badRequest('A multipart body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MULTIPART_BYTES) throw new PayloadTooLarge();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const copy = new Request(request.url, { method: 'POST', headers: { 'content-type': contentType },
    body: Buffer.concat(chunks, size) });
  try { return await copy.formData(); }
  catch { throw badRequest('Malformed multipart body'); }
}

export class PayloadTooLarge extends ApiError {
  constructor() { super(413, 'PAYLOAD_TOO_LARGE', 'GLB upload exceeds 32 MiB'); }
}

export function parseUpload(form: FormData) {
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('A GLB file is required');
  const fields: Record<string, unknown> = {};
  for (const key of ['name', 'visibility', 'transform', 'metadata']) {
    const value = form.get(key);
    if (value !== null) fields[key] = value;
  }
  for (const key of form.keys()) {
    if (!['file', 'name', 'visibility', 'transform', 'metadata'].includes(key) || form.getAll(key).length !== 1)
      throw badRequest('Unexpected or repeated multipart field');
  }
  for (const key of ['transform', 'metadata']) {
    if (fields[key] !== undefined) {
      try { fields[key] = JSON.parse(String(fields[key])); }
      catch { throw badRequest(`${key} must contain valid JSON`); }
    }
  }
  return { file, input: scanInput.parse(fields) };
}

export function validateGlb(bytes: Uint8Array, filename: string) {
  if (!filename.toLowerCase().endsWith('.glb')) throw badRequest('Only .glb files are supported');
  if (bytes.byteLength > MAX_GLB_BYTES) throw new PayloadTooLarge();
  if (bytes.byteLength < 20) throw badRequest('Invalid GLB file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.byteLength || view.getUint32(16, true) !== 0x4e4f534a)
    throw badRequest('Invalid GLB header');
  const jsonLength = view.getUint32(12, true);
  if (jsonLength === 0 || jsonLength % 4 !== 0 || jsonLength + 20 > bytes.byteLength)
    throw badRequest('Invalid GLB JSON chunk');
  try {
    const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + jsonLength)));
    if (json?.asset?.version !== '2.0') throw new Error('Invalid asset version');
  } catch { throw badRequest('Invalid GLB JSON chunk'); }
  let offset = 20 + jsonLength;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw badRequest('Invalid GLB chunk');
    const chunkLength = view.getUint32(offset, true);
    if (chunkLength % 4 !== 0 || offset + 8 + chunkLength > bytes.byteLength) throw badRequest('Invalid GLB chunk');
    offset += 8 + chunkLength;
  }
}

export async function canReadScan(db: Db, user: AppUser | null, scan: Scan) {
  const [space] = await db.select().from(spaces).where(eq(spaces.id, scan.spaceId)).limit(1);
  if (!space || !(await canReadSpace(db, user, space))) return false;
  if (scan.ownerId === user?.id) return true;
  if (scan.status !== 'ready') return false;
  if (scan.visibility === 'public') return true;
  if (!user) return false;
  const [grant] = await db.select({ userId: scanViewers.userId }).from(scanViewers)
    .where(and(eq(scanViewers.scanId, scan.id), eq(scanViewers.userId, user.id))).limit(1);
  return !!grant;
}

export async function readScan(db: Db, user: AppUser | null, id: string) {
  const [scan] = await db.select().from(scans).where(eq(scans.id, uuid.parse(id))).limit(1);
  if (!scan || !(await canReadScan(db, user, scan))) throw notFound();
  return scan;
}

export async function listScans(db: Db, user: AppUser | null, spaceId: string) {
  await readSpace(db, user, uuid.parse(spaceId));
  const rows = await db.select().from(scans).where(eq(scans.spaceId, spaceId));
  const accessible: Scan[] = [];
  for (const row of rows) if (await canReadScan(db, user, row)) accessible.push(row);
  return accessible.map(scanResponse);
}

export function scanResponse(scan: Scan) {
  const { objectKey, ...safe } = scan;
  return { ...safe, downloadPath: scan.status === 'ready' ? `/api/scans/${scan.id}/file` : null };
}

export async function createScan(db: Db, storage: ScanStorage, user: AppUser, spaceId: string,
  input: z.infer<typeof scanInput>, bytes: Uint8Array, filename: string) {
  const space = await readSpace(db, user, uuid.parse(spaceId));
  requireOwner(user, space.ownerId);
  if (input.visibility === 'public' && space.visibility !== 'public') throw badRequest('A public scan requires a public space');
  validateGlb(bytes, filename);
  const id = randomUUID();
  const objectKey = `scans/${id}.glb`;
  await storage.put(objectKey, bytes);
  try {
    const [scan] = await db.insert(scans).values({ id, spaceId, ownerId: user.id,
      name: input.name, visibility: input.visibility ?? 'private', transform: input.transform,
      metadata: input.metadata ?? {}, format: 'glb', status: 'ready', byteSize: bytes.byteLength, objectKey }).returning();
    return scanResponse(scan);
  } catch (error) {
    await storage.delete(objectKey).catch(cleanupError => console.error('Scan upload cleanup failed', cleanupError));
    throw error;
  }
}

export async function updateScan(db: Db, user: AppUser, id: string, input: z.infer<typeof scanPatch>) {
  const scan = await readScan(db, user, id);
  requireOwner(user, scan.ownerId);
  if (input.visibility === 'public') {
    const [space] = await db.select().from(spaces).where(eq(spaces.id, scan.spaceId)).limit(1);
    if (space?.visibility !== 'public') throw badRequest('A public scan requires a public space');
  }
  const [updated] = await db.update(scans).set({ ...input, updatedAt: new Date() }).where(eq(scans.id, scan.id)).returning();
  return scanResponse(updated);
}

export async function deleteScan(db: Db, storage: ScanStorage, user: AppUser, id: string) {
  const scan = await readScan(db, user, id);
  requireOwner(user, scan.ownerId);
  await db.delete(scans).where(eq(scans.id, scan.id));
  // An object-store failure leaves an orphan, never a database row pointing to missing bytes.
  await storage.delete(scan.objectKey);
}

export async function downloadScan(db: Db, storage: ScanStorage, user: AppUser | null, id: string) {
  const scan = await readScan(db, user, id);
  if (scan.status !== 'ready') throw conflict('Scan is not ready for download');
  if (!(await storage.exists(scan.objectKey))) throw notFound();
  return { scan, bytes: await storage.get(scan.objectKey) };
}
