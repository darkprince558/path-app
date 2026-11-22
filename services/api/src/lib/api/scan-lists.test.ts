import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { connectDatabase } from '../../db/client';
import { scans, scanViewers, spaces, users } from '../../db/schema';
import { LocalScanStorage } from '../storage';
import { GET as mineRoute } from '../../app/api/scans/mine/route';
import { GET as sharedRoute } from '../../app/api/scans/shared/route';
import { listMyScans, listPublicScans, listSharedScans } from './scan-lists';
import { createScan, identityTransform } from './scans';

function sampleGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(20 + paddedLength, 0x20);
  bytes.write('glTF', 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(paddedLength, 12);
  bytes.write('JSON', 16);
  json.copy(bytes, 20);
  return bytes;
}

test('your maps and shared-with-me lists require sign-in', async () => {
  const headers = { Authorization: 'Bearer invalid' };
  assert.equal((await mineRoute(new Request('http://localhost/api/scans/mine', { headers }))).status, 401);
  assert.equal((await sharedRoute(new Request('http://localhost/api/scans/shared', { headers }))).status, 401);
});

test('mine, public and shared lists follow the scan access rules', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { db, client } = connectDatabase();
  const root = await mkdtemp(path.join(tmpdir(), 'path-app-scan-lists-'));
  const storage = new LocalScanStorage(root);
  const suffix = randomUUID();
  const userIds: string[] = [];
  const spaceIds: string[] = [];
  try {
    const [owner] = await db.insert(users).values({ auth0Sub: `test|${suffix}|owner`, username: `lists_${suffix}_owner`, displayName: 'Owner' }).returning();
    const [viewer] = await db.insert(users).values({ auth0Sub: `test|${suffix}|viewer`, username: `lists_${suffix}_viewer`, displayName: 'Viewer' }).returning();
    const [stranger] = await db.insert(users).values({ auth0Sub: `test|${suffix}|stranger`, username: `lists_${suffix}_stranger`, displayName: 'Stranger' }).returning();
    userIds.push(owner.id, viewer.id, stranger.id);
    const [publicSpace] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Public hall', visibility: 'public' }).returning();
    const [privateSpace] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Private hall' }).returning();
    spaceIds.push(publicSpace.id, privateSpace.id);
    const base = { transform: identityTransform };
    const open = await createScan(db, storage, owner, publicSpace.id, { ...base, name: 'Open map', visibility: 'public' }, sampleGlb(), 'open.glb');
    const granted = await createScan(db, storage, owner, publicSpace.id, { ...base, name: 'Granted map', visibility: 'private' }, sampleGlb(), 'granted.glb');
    const hidden = await createScan(db, storage, owner, privateSpace.id, { ...base, name: 'Hidden map', visibility: 'private' }, sampleGlb(), 'hidden.glb');
    await db.insert(scanViewers).values({ scanId: granted.id, userId: viewer.id });

    const mine = await listMyScans(db, owner);
    assert.deepEqual(new Set(mine.map(scan => scan.id)), new Set([open.id, granted.id, hidden.id]));
    const grantedRow = mine.find(scan => scan.id === granted.id);
    assert.equal(grantedRow?.shareId, granted.shareId);
    assert.equal(grantedRow?.sharePath, `/s/${granted.shareId}`);
    assert.deepEqual(grantedRow?.viewers, [{ id: viewer.id, displayName: 'Viewer' }]);
    assert.equal(grantedRow?.revisionId, null); // manual upload: no processed revision, so no cues
    assert.deepEqual(await listMyScans(db, stranger), []);

    // Public lists ready public scans in readable spaces only, for anyone.
    const publicIds = (await listPublicScans(db)).map(scan => scan.shareId);
    assert.ok(publicIds.includes(open.shareId));
    assert.ok(!publicIds.includes(granted.shareId));
    assert.ok(!publicIds.includes(hidden.shareId));

    // Shared lists grants only, names the owner and never includes viewer lists.
    const shared = await listSharedScans(db, viewer);
    assert.deepEqual(shared.map(scan => scan.shareId), [granted.shareId]);
    assert.equal(shared[0].owner, 'Owner');
    assert.equal('viewerIds' in shared[0], false);
    assert.deepEqual(await listSharedScans(db, stranger), []);
    assert.deepEqual(await listSharedScans(db, owner), []);
  } finally {
    for (const spaceId of spaceIds) {
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
