import type { connectDatabase } from '../../db/client';
import { requireOwner } from '../auth/authorization';
import type { AppUser } from '../auth/user-sync';
import { thumbnailObjectKey, type ScanStorage } from '../storage';
import { ApiError, badRequest, notFound, signedIn } from './http';
import { readScan } from './scans';
import { readShare } from './shares';

/*
 * Map-card pictures. The website renders a small JPEG of the 3D view the first time the
 * owner opens a map that has none, and saves it here. Anyone who can open the map can
 * see its picture; only the owner can replace it. Deleting the scan deletes it too.
 *
 *   PUT /api/scans/<scanId>/thumbnail       image/jpeg body, owner only  -> 204
 *   GET /api/shares/<shareId>/thumbnail     -> image/jpeg, or 404 when there is none yet
 */

type Db = ReturnType<typeof connectDatabase>['db'];

/** About 480 x 288 at JPEG quality 0.8 is 20-60 KB; this leaves plenty of room. */
export const MAX_THUMBNAIL_BYTES = 512 * 1024;

const tooLarge = () => new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Thumbnail exceeds 512 KiB');

export function validateJpeg(bytes: Uint8Array) {
  const n = bytes.byteLength;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[n - 2] !== 0xff || bytes[n - 1] !== 0xd9) {
    throw badRequest('Thumbnail must be a JPEG image');
  }
}

export async function readThumbnailBody(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/jpeg') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'image/jpeg is required');
  }
  if (Number(request.headers.get('content-length')) > MAX_THUMBNAIL_BYTES) throw tooLarge();
  if (!request.body) throw badRequest('A JPEG body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_THUMBNAIL_BYTES) throw tooLarge();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks, size);
  validateJpeg(bytes);
  return bytes;
}

export async function saveThumbnail(db: Db, storage: ScanStorage, user: AppUser | null, scanId: string, bytes: Uint8Array) {
  const owner = signedIn(user);
  const scan = await readScan(db, owner, scanId);
  requireOwner(owner, scan.ownerId);
  validateJpeg(bytes);
  await storage.put(thumbnailObjectKey(scan.id), bytes);
}

export async function shareThumbnail(db: Db, storage: ScanStorage, user: AppUser | null, shareId: string) {
  const scan = await readShare(db, user, shareId);
  const key = thumbnailObjectKey(scan.id);
  if (!(await storage.exists(key))) throw notFound();
  return storage.get(key);
}
