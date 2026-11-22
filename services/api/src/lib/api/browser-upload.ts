import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { connectDatabase } from '../../db/client';
import { scans, spaces } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import type { ScanStorage } from '../storage';
import { ApiError, badRequest } from './http';
import { identityTransform, MAX_GLB_BYTES, PayloadTooLarge, scanResponse, scanVisibility, validateGlb } from './scans';

const uploadName = z.string().transform(value => value.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/));

export async function parseBrowserUpload(request: Request) {
  const query = new URL(request.url).searchParams;
  if (query.get('format') !== 'glb') throw new ApiError(415, 'UNSUPPORTED_FORMAT', 'Only GLB uploads are supported');
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream')
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'application/octet-stream is required');
  const input = { name: uploadName.parse(query.get('name') ?? 'Untitled map'),
    visibility: scanVisibility.parse(query.get('visibility') ?? 'private') };
  if (Number(request.headers.get('content-length')) > MAX_GLB_BYTES) throw new PayloadTooLarge();
  if (!request.body) throw badRequest('A GLB body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GLB_BYTES) throw new PayloadTooLarge();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks, size);
  validateGlb(bytes, 'scene.glb');
  return { input, bytes };
}

/** Each browser import gets an undiscoverable container; scan visibility controls reads. */
export async function createBrowserScan(db: ReturnType<typeof connectDatabase>['db'], storage: ScanStorage,
  user: AppUser, input: { name: string; visibility: z.infer<typeof scanVisibility> }, bytes: Uint8Array) {
  validateGlb(bytes, 'scene.glb');
  const id = randomUUID();
  const objectKey = `scans/${id}.glb`;
  await storage.put(objectKey, bytes);
  try {
    return await db.transaction(async tx => {
      const [space] = await tx.insert(spaces).values({ ownerId: user.id, name: 'Uploaded map', visibility: 'unlisted',
        boundary: { browserUploadScanId: id } }).returning();
      const [scan] = await tx.insert(scans).values({ id, spaceId: space.id, ownerId: user.id,
        name: input.name, visibility: input.visibility, transform: identityTransform,
        format: 'glb', status: 'ready', byteSize: bytes.byteLength, objectKey }).returning();
      return scanResponse(scan);
    });
  } catch (error) {
    await storage.delete(objectKey).catch(() => console.error('Browser upload object cleanup failed'));
    throw error;
  }
}
