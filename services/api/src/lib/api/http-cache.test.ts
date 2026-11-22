import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { scans, spaces, users } from '../../db/schema';
import type { ScanStorage } from '../storage';
import { cachedAsset, CACHED_ASSET_CONTROL, contentEtag, etagFor, notModified } from './http-cache';
import { shareSceneResponse } from './shares';

const req = (ifNoneMatch?: string) => new Request('http://localhost/x', ifNoneMatch ? { headers: { 'If-None-Match': ifNoneMatch } } : {});

test('ETags are stable, opaque and change with their inputs', () => {
  const a = etagFor('scene', 'scan-1', 'scans/abc.glb', 100);
  assert.equal(a, etagFor('scene', 'scan-1', 'scans/abc.glb', 100));
  assert.match(a, /^"[0-9a-f]{40}"$/);
  assert.ok(!a.includes('scans/abc'), 'object keys must not leak');
  assert.notEqual(a, etagFor('scene', 'scan-1', 'scans/abd.glb', 100));
  assert.notEqual(a, etagFor('scene', 'scan-1', 'scans/abc.glb', 101));
  assert.notEqual(etagFor('a', 'bc'), etagFor('ab', 'c')); // separator keeps parts distinct
  assert.notEqual(contentEtag(new Uint8Array([1, 2])), contentEtag(new Uint8Array([1, 3])));
});

test('If-None-Match matching follows the HTTP rules', () => {
  const tag = '"abc"';
  assert.equal(notModified(req(), tag), false);
  assert.equal(notModified(req('"abc"'), tag), true);
  assert.equal(notModified(req('W/"abc"'), tag), true);
  assert.equal(notModified(req('"x", "abc"'), tag), true);
  assert.equal(notModified(req('*'), tag), true);
  assert.equal(notModified(req('"abcd"'), tag), false);
});

test('cachedAsset sends the file with revalidation headers, or a body-less 304', async () => {
  let loads = 0;
  const load = async () => { loads++; return new Uint8Array([7, 8, 9]); };
  const full = await cachedAsset(req(), '"v1"', 'model/gltf-binary', load);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('ETag'), '"v1"');
  assert.equal(full.headers.get('Cache-Control'), CACHED_ASSET_CONTROL);
  assert.equal(full.headers.get('Content-Type'), 'model/gltf-binary');
  assert.equal(full.headers.get('Content-Length'), '3');
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), new Uint8Array([7, 8, 9]));
  const again = await cachedAsset(req('"v1"'), '"v1"', 'model/gltf-binary', load);
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('ETag'), '"v1"');
  assert.equal((await again.arrayBuffer()).byteLength, 0);
  assert.equal(loads, 1, 'a 304 must not read the file');
  assert.equal((await cachedAsset(req('"old"'), '"v1"', 'model/gltf-binary', load)).status, 200);
});

/** In-memory scan storage that counts reads. */
function memoryStorage() {
  const files = new Map<string, Uint8Array>(); let reads = 0;
  const storage: ScanStorage = {
    async put(key, bytes) { files.set(key, bytes); },
    async get(key) { reads++; const value = files.get(key); if (!value) throw new Error('missing'); return value; },
    async delete(key) { files.delete(key); },
    async exists(key) { return files.has(key); },
  };
  return { storage, reads: () => reads };
}

test('reopening a shared map revalidates instead of re-downloading, and access still applies', { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 }, async () => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 5, prepare: false }); const db = drizzle(client);
  const userIds: string[] = []; const spaceIds: string[] = [];
  try {
    const suffix = randomUUID();
    const [owner, stranger] = await db.insert(users).values([
      { auth0Sub: `cache|${suffix}`, username: `cache_${suffix}`, displayName: 'Owner' },
      { auth0Sub: `cache-x|${suffix}`, username: `cache_x_${suffix}`, displayName: 'Stranger' },
    ]).returning(); userIds.push(owner.id, stranger.id);
    const [space] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Uploaded map', visibility: 'unlisted' }).returning();
    spaceIds.push(space.id);
    const { storage, reads } = memoryStorage();
    const bytes = new Uint8Array([103, 108, 84, 70, 2, 0, 0, 0]);
    const objectKey = `scans/${randomUUID()}.glb`;
    await storage.put(objectKey, bytes);
    const [scan] = await db.insert(scans).values({ spaceId: space.id, ownerId: owner.id, name: 'Hall', objectKey, byteSize: bytes.length,
      format: 'glb', status: 'ready', visibility: 'unlisted', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }).returning();

    // First open: full download with an ETag the browser can keep.
    const first = await shareSceneResponse(req(), db, storage, null, scan.shareId);
    assert.equal(first.status, 200);
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), bytes);
    const etag = first.headers.get('ETag')!;
    assert.equal(first.headers.get('Cache-Control'), 'private, no-cache');
    assert.equal(reads(), 1);

    // Reopen: 304, no file read.
    const second = await shareSceneResponse(req(etag), db, storage, null, scan.shareId);
    assert.equal(second.status, 304);
    assert.equal(reads(), 1);

    // A new upload is a different file with a different ETag.
    const otherKey = `scans/${randomUUID()}.glb`;
    await storage.put(otherKey, new Uint8Array([103, 108, 84, 70, 2, 0, 0, 1]));
    const [other] = await db.insert(scans).values({ spaceId: space.id, ownerId: owner.id, name: 'Hall 2', objectKey: otherKey, byteSize: 8,
      format: 'glb', status: 'ready', visibility: 'unlisted', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }).returning();
    const otherFirst = await shareSceneResponse(req(etag), db, storage, null, other.shareId);
    assert.equal(otherFirst.status, 200);
    assert.notEqual(otherFirst.headers.get('ETag'), etag);

    // Made private: a guest holding a cached copy is refused before any 304.
    await db.update(scans).set({ visibility: 'private' }).where(eq(scans.id, scan.id));
    await assert.rejects(shareSceneResponse(req(etag), db, storage, null, scan.shareId), { status: 404 });
    await assert.rejects(shareSceneResponse(req(etag), db, storage, stranger, scan.shareId), { status: 404 });
    assert.equal((await shareSceneResponse(req(etag), db, storage, owner, scan.shareId)).status, 304);
  } finally {
    if (spaceIds.length) { await db.delete(scans).where(inArray(scans.spaceId, spaceIds)); await db.delete(spaces).where(inArray(spaces.id, spaceIds)); }
    for (const id of userIds) await db.delete(users).where(eq(users.id, id)).catch(() => {});
    await client.end();
  }
});
