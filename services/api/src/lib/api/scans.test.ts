import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { connectDatabase } from '../../db/client';
import { scans, spaces, users } from '../../db/schema';
import { LocalScanStorage } from '../storage';
import { POST as uploadRoute } from '../../app/api/spaces/[id]/scans/route';
import { GET as downloadRoute } from '../../app/api/scans/[id]/file/route';
import { boundedFormData, canReadScan, createScan, deleteScan, downloadScan, identityTransform,
  listScans, parseUpload, readScan, updateScan, validateGlb } from './scans';

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

test('GLB validation and multipart fields reject invalid files and transforms', () => {
  const bytes = sampleGlb();
  validateGlb(bytes, 'venue.glb');
  assert.throws(() => validateGlb(bytes, 'venue.png'));
  assert.throws(() => validateGlb(Buffer.from('not a GLB'), 'venue.glb'));
  const wrongSize = Buffer.from(bytes);
  wrongSize.writeUInt32LE(bytes.length + 4, 8);
  assert.throws(() => validateGlb(wrongSize, 'venue.glb'));
  const form = new FormData();
  form.set('file', new File([bytes], 'venue.glb'));
  form.set('name', 'Hall');
  form.set('transform', JSON.stringify(identityTransform));
  assert.equal(parseUpload(form).input.name, 'Hall');
  form.set('transform', JSON.stringify([1, 2]));
  assert.throws(() => parseUpload(form));
});

test('invalid bearer tokens cannot upload or download', async () => {
  const id = randomUUID();
  const headers = { Authorization: 'Bearer invalid' };
  const upload = await uploadRoute(new Request(`http://localhost/api/spaces/${id}/scans`, {
    method: 'POST', headers,
  }), { params: Promise.resolve({ id }) });
  const download = await downloadRoute(new Request(`http://localhost/api/scans/${id}/file`, {
    headers,
  }), { params: Promise.resolve({ id }) });
  assert.equal(upload.status, 401);
  assert.equal(download.status, 401);
});

test('multipart upload rejects an oversized request before parsing', async () => {
  const request = new Request('http://localhost/api/scans', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=test', 'Content-Length': String(34 * 1024 * 1024) },
    body: 'small',
  });
  await assert.rejects(boundedFormData(request), { status: 413 });
});

test('documented triangle GLB fixture passes upload validation', async () => {
  const bytes = await readFile(new URL('../../../../../fixtures/venue/sample-triangle.glb', import.meta.url));
  validateGlb(bytes, 'sample-triangle.glb');
});

test('scan upload/download, access, multiple scans and cleanup', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { db, client } = connectDatabase();
  const root = await mkdtemp(path.join(tmpdir(), 'path-app-scan-test-'));
  const storage = new LocalScanStorage(root);
  const suffix = randomUUID();
  let ownerId: string | undefined;
  let viewerId: string | undefined;
  let privateSpaceId: string | undefined;
  let publicSpaceId: string | undefined;
  try {
    const [owner] = await db.insert(users).values({ auth0Sub: `test|${suffix}|scan-owner`, username: `scan_${suffix}_owner`, displayName: 'Owner' }).returning();
    const [viewer] = await db.insert(users).values({ auth0Sub: `test|${suffix}|scan-viewer`, username: `scan_${suffix}_viewer`, displayName: 'Viewer' }).returning();
    ownerId = owner.id; viewerId = viewer.id;
    const [privateSpace] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Private hall' }).returning();
    const [publicSpace] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Public hall', visibility: 'public' }).returning();
    privateSpaceId = privateSpace.id; publicSpaceId = publicSpace.id;
    const bytes = sampleGlb();
    const input = { name: 'Scan A', visibility: 'private' as const, transform: identityTransform };
    await assert.rejects(createScan(db, storage, viewer, publicSpace.id, input, bytes, 'a.glb'));
    await assert.rejects(createScan(db, storage, owner, privateSpace.id, { ...input, visibility: 'public' }, bytes, 'a.glb'));
    await assert.rejects(createScan(db, storage, owner, publicSpace.id, input, Buffer.from('fake'), 'a.glb'));
    const privateScan = await createScan(db, storage, owner, publicSpace.id, input, bytes, 'a.glb');
    const publicScan = await createScan(db, storage, owner, publicSpace.id,
      { ...input, name: 'Scan B', visibility: 'public' }, bytes, 'b.glb');
    assert.notEqual(privateScan.id, publicScan.id);
    assert.equal((await listScans(db, owner, publicSpace.id)).length, 2);
    assert.deepEqual((await listScans(db, null, publicSpace.id)).map(s => s.id), [publicScan.id]);
    await assert.rejects(readScan(db, null, privateScan.id));
    await assert.rejects(downloadScan(db, storage, viewer, privateScan.id));
    await assert.rejects(readScan(db, viewer, privateScan.id));
    assert.deepEqual((await downloadScan(db, storage, null, publicScan.id)).bytes, bytes);
    assert.deepEqual((await downloadScan(db, storage, owner, privateScan.id)).bytes, bytes);
    const [privateRow] = await db.select().from(scans).where(eq(scans.id, privateScan.id));
    assert.equal(await canReadScan(db, null, privateRow), false);
    assert.equal(await storage.exists(privateRow.objectKey), true);
    await updateScan(db, owner, privateScan.id, { name: 'Renamed', transform: [...identityTransform] });
    await assert.rejects(updateScan(db, viewer, privateScan.id, { name: 'Stolen' }));
    await deleteScan(db, storage, owner, privateScan.id);
    assert.equal(await storage.exists(privateRow.objectKey), false);
    await assert.rejects(readScan(db, owner, privateScan.id));
    await deleteScan(db, storage, owner, publicScan.id);
    assert.equal((await listScans(db, owner, publicSpace.id)).length, 0);
  } finally {
    if (publicSpaceId) {
      await db.delete(scans).where(eq(scans.spaceId, publicSpaceId));
      await db.delete(spaces).where(eq(spaces.id, publicSpaceId));
    }
    if (privateSpaceId) await db.delete(spaces).where(eq(spaces.id, privateSpaceId));
    if (ownerId) await db.delete(users).where(eq(users.id, ownerId)).catch(() => {});
    if (viewerId) await db.delete(users).where(eq(users.id, viewerId)).catch(() => {});
    await client.end();
    await rm(root, { recursive: true, force: true });
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});
