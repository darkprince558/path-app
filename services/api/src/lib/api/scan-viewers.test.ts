import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { connectDatabase } from '../../db/client';
import { scans, spaces, users } from '../../db/schema';
import { verifiedEmail } from '../auth/user-sync';
import { LocalScanStorage } from '../storage';
import { GET as listRoute, POST as addRoute } from '../../app/api/scans/[id]/viewers/route';
import { DELETE as removeRoute } from '../../app/api/scans/[id]/viewers/[userId]/route';
import { ApiError } from './http';
import { listSharedScans } from './scan-lists';
import { addViewer, listViewers, removeViewer, viewerInput } from './scan-viewers';
import { canReadScan, createScan, identityTransform } from './scans';

function sampleGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(20 + paddedLength, 0x20);
  bytes.write('glTF', 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(paddedLength, 12); bytes.write('JSON', 16); json.copy(bytes, 20);
  return bytes;
}

test('only verified emails are stored, lower-cased', () => {
  assert.equal(verifiedEmail(' Ari@Example.COM ', true), 'ari@example.com');
  assert.equal(verifiedEmail('ari@example.com', false), undefined);
  assert.equal(verifiedEmail('ari@example.com', undefined), undefined);
  assert.equal(verifiedEmail(42, true), undefined);
  assert.deepEqual(viewerInput.parse({ email: '  Ari@Example.com ' }), { email: 'ari@example.com' });
  assert.throws(() => viewerInput.parse({ email: 'not-an-email' }));
});

test('viewer routes require sign-in', async () => {
  const headers = { Authorization: 'Bearer invalid' };
  const id = randomUUID();
  const params = Promise.resolve({ id, userId: randomUUID() });
  assert.equal((await listRoute(new Request(`http://localhost/api/scans/${id}/viewers`, { headers }), { params })).status, 401);
  assert.equal((await addRoute(new Request(`http://localhost/api/scans/${id}/viewers`, { method: 'POST', headers, body: '{"email":"a@b.co"}' }), { params })).status, 401);
  assert.equal((await removeRoute(new Request(`http://localhost/api/scans/${id}/viewers/x`, { method: 'DELETE', headers }), { params })).status, 401);
});

test('owners add and remove people on a private map by email', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { db, client } = connectDatabase();
  const root = await mkdtemp(path.join(tmpdir(), 'path-app-viewers-'));
  const storage = new LocalScanStorage(root);
  const suffix = randomUUID();
  const userIds: string[] = [];
  let spaceId: string | undefined;
  const person = (role: string, email: string | null) => db.insert(users).values({
    auth0Sub: `test|${suffix}|${role}`, username: `viewers_${suffix}_${role}`, displayName: role, email }).returning().then(rows => rows[0]);
  try {
    const owner = await person('Owner', `owner-${suffix}@example.com`);
    const friend = await person('Friend', `friend-${suffix}@example.com`);
    const friendGoogle = await person('Friend via Google', `friend-${suffix}@example.com`);
    const stranger = await person('Stranger', null);
    userIds.push(owner.id, friend.id, friendGoogle.id, stranger.id);
    const [space] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Uploads', visibility: 'unlisted' }).returning();
    spaceId = space.id;
    const map = await createScan(db, storage, owner, space.id,
      { transform: identityTransform, name: 'Private map', visibility: 'private' }, sampleGlb(), 'map.glb');
    const [row] = await db.select().from(scans).where(eq(scans.id, map.id));

    assert.equal(await canReadScan(db, friend, row), false);
    assert.deepEqual((await listViewers(db, owner, map.id)).viewers, []);

    // Mixed case input matches; every account with that verified email is added.
    const added = await addViewer(db, owner, map.id, viewerInput.parse({ email: `FRIEND-${suffix}@Example.com` }));
    assert.deepEqual(new Set(added.viewers.map(v => v.id)), new Set([friend.id, friendGoogle.id]));
    assert.ok(added.viewers.every(v => v.email === `friend-${suffix}@example.com`));
    assert.equal(await canReadScan(db, friend, row), true);
    assert.deepEqual((await listSharedScans(db, friend)).map(s => s.shareId), [map.shareId]);
    assert.equal(await canReadScan(db, stranger, row), false);

    // Adding twice is harmless.
    assert.equal((await addViewer(db, owner, map.id, { email: `friend-${suffix}@example.com` })).viewers.length, 2);

    await assert.rejects(addViewer(db, owner, map.id, { email: `nobody-${suffix}@example.com` }),
      (error: unknown) => error instanceof ApiError && error.status === 404 && /sign in/.test(error.message));
    await assert.rejects(addViewer(db, owner, map.id, { email: `owner-${suffix}@example.com` }),
      (error: unknown) => error instanceof ApiError && error.status === 400);

    // Only the owner manages people; a viewer sees 403 and an outsider sees 404.
    await assert.rejects(listViewers(db, friend, map.id), (error: unknown) => (error as { status?: number }).status === 403);
    await assert.rejects(addViewer(db, friend, map.id, { email: `owner-${suffix}@example.com` }),
      (error: unknown) => (error as { status?: number }).status === 403);
    await assert.rejects(listViewers(db, stranger, map.id), (error: unknown) => error instanceof ApiError && error.status === 404);

    const after = await removeViewer(db, owner, map.id, friend.id);
    assert.deepEqual(after.viewers.map(v => v.id), [friendGoogle.id]);
    assert.equal(await canReadScan(db, friend, row), false);
    assert.equal(await canReadScan(db, friendGoogle, row), true);
  } finally {
    if (spaceId) {
      await db.delete(scans).where(eq(scans.spaceId, spaceId));
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    }
    for (const userId of userIds) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
    await client.end();
    await rm(root, { recursive: true, force: true });
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});
