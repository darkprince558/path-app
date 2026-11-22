import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { connectDatabase } from '../../db/client';
import { scans, spaces, users } from '../../db/schema';
import { LocalScanStorage, thumbnailObjectKey } from '../storage';
import { createBrowserScan } from './browser-upload';
import { deleteScan, updateScan } from './scans';
import { MAX_THUMBNAIL_BYTES, readThumbnailBody, saveThumbnail, shareThumbnail, validateJpeg } from './thumbnails';

/** Smallest byte pattern validateJpeg accepts: SOI ... EOI. */
const jpeg = (fill = 0) => Buffer.from([0xff, 0xd8, fill, fill, 0xff, 0xd9]);
const put = (bytes: Uint8Array, type = 'image/jpeg') => new Request('http://localhost/api/scans/x/thumbnail', {
  method: 'PUT', headers: { 'Content-Type': type }, body: Uint8Array.from(bytes) });

test('thumbnail uploads must be small JPEGs', async () => {
  validateJpeg(jpeg());
  assert.throws(() => validateJpeg(Buffer.from('not a jpeg')), { status: 400 });
  assert.deepEqual(await readThumbnailBody(put(jpeg())), jpeg());
  await assert.rejects(readThumbnailBody(put(jpeg(), 'image/png')), { status: 415 });
  await assert.rejects(readThumbnailBody(put(Buffer.from('nope'))), { status: 400 });
  const big = Buffer.alloc(MAX_THUMBNAIL_BYTES + 2); big[0] = 0xff; big[1] = 0xd8;
  await assert.rejects(readThumbnailBody(put(big)), { status: 413 });
  assert.equal(thumbnailObjectKey('0f8fad5b-d9cb-469f-a165-70867728950e'), 'scans/0f8fad5b-d9cb-469f-a165-70867728950e.jpg');
});

test('only the owner saves a thumbnail; readers of the map can see it; deleting the scan removes it', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { db, client } = connectDatabase();
  const root = await mkdtemp(path.join(tmpdir(), 'thumbnails-'));
  const storage = new LocalScanStorage(root);
  const userIds: string[] = [], spaceIds: string[] = [];
  try {
    const suffix = randomUUID();
    const [owner, other] = await db.insert(users).values(['owner', 'other'].map(role => ({
      auth0Sub: `test|thumb|${suffix}|${role}`, username: `${suffix}_${role}`, displayName: role,
    }))).returning();
    userIds.push(owner.id, other.id);
    const glb = await readFile(new URL('../../../../../fixtures/venue/sample-triangle.glb', import.meta.url));
    const scan = await createBrowserScan(db, storage, owner, { name: 'Hall', visibility: 'unlisted' }, glb);
    spaceIds.push(scan.spaceId);

    await assert.rejects(shareThumbnail(db, storage, null, scan.shareId), { status: 404 });
    await assert.rejects(saveThumbnail(db, storage, null, scan.id, jpeg()), { status: 401 });
    await assert.rejects(saveThumbnail(db, storage, other, scan.id, jpeg()), { status: 403 });
    await saveThumbnail(db, storage, owner, scan.id, jpeg(7));
    assert.deepEqual(Buffer.from(await shareThumbnail(db, storage, null, scan.shareId)), jpeg(7));

    await updateScan(db, owner, scan.id, { visibility: 'private' });
    await assert.rejects(shareThumbnail(db, storage, other, scan.shareId), { status: 404 });
    assert.deepEqual(Buffer.from(await shareThumbnail(db, storage, owner, scan.shareId)), jpeg(7));

    await deleteScan(db, storage, owner, scan.id);
    assert.equal(await storage.exists(thumbnailObjectKey(scan.id)), false);
  } finally {
    for (const id of spaceIds) {
      await db.delete(scans).where(eq(scans.spaceId, id));
      await db.delete(spaces).where(eq(spaces.id, id));
    }
    for (const id of userIds) await db.delete(users).where(eq(users.id, id));
    await client.end();
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});
