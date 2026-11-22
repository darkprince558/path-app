import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { connectDatabase } from '../../db/client';
import { eventMembers, events, eventSpaces, scans, scanViewers, spaces, users } from '../../db/schema';
import { LocalScanStorage } from '../storage';
import { POST as uploadRoute } from '../../app/api/spaces/[id]/scans/route';
import { GET as downloadRoute } from '../../app/api/scans/[id]/file/route';
import { boundedFormData, canReadScan, createScan, deleteScan, downloadScan, identityTransform,
  listScans, parseUpload, readScan, transform, updateScan, validateGlb } from './scans';

function sampleGlb(extra: Record<string, unknown> = {}) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], ...extra }));
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

test('GLB is self-contained and alignment cannot collapse geometry or add perspective', () => {
  for (const key of ['buffers', 'images']) {
    for (const uri of ['textures/room.jpg', 'https://example.com/room.bin', '//example.com/file', 'blob:other-session']) {
      assert.throws(() => validateGlb(sampleGlb({ [key]: [{ uri }] }), 'room.glb'), /must be embedded/);
    }
    validateGlb(sampleGlb({ [key]: [{ uri: 'data:application/octet-stream;base64,AAAA' }] }), 'room.glb');
  }
  const calibrated = [...identityTransform];
  calibrated[0] = calibrated[5] = calibrated[10] = 0.00001;
  calibrated[12] = 2;
  assert.deepEqual(transform.parse(calibrated), calibrated);
  for (const [index, value] of [[0, 0], [3, 1], [7, 1], [11, 1], [15, 0], [15, 0.9999998], [12, Infinity]]) {
    const invalid = [...identityTransform]; invalid[index] = value;
    assert.equal(transform.safeParse(invalid).success, false);
  }
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
  let eventId: string | undefined;
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
    // Being a member of an event grants graph access, never access to every private scan.
    const restrictedScan = await createScan(db, storage, owner, privateSpace.id, input, bytes, 'private.glb');
    const [event] = await db.insert(events).values({ ownerId: owner.id, name: 'Scan membership test' }).returning();
    eventId = event.id;
    await db.insert(eventSpaces).values({ eventId: event.id, spaceId: privateSpace.id });
    await db.insert(eventMembers).values({ eventId: event.id, userId: viewer.id });
    assert.deepEqual(await listScans(db, viewer, privateSpace.id), []);
    await assert.rejects(downloadScan(db, storage, viewer, restrictedScan.id), { status: 404 });
    await db.insert(scanViewers).values({ scanId: restrictedScan.id, userId: viewer.id });
    assert.deepEqual((await downloadScan(db, storage, viewer, restrictedScan.id)).bytes, bytes);
    await db.delete(eventMembers).where(eq(eventMembers.eventId, event.id));
    await assert.rejects(downloadScan(db, storage, viewer, restrictedScan.id), { status: 404 });
    await deleteScan(db, storage, owner, restrictedScan.id);
    // Visibility changes apply to raw bytes on the next request.
    await updateScan(db, owner, publicScan.id, { visibility: 'private' });
    await assert.rejects(downloadScan(db, storage, null, publicScan.id), { status: 404 });
    await updateScan(db, owner, publicScan.id, { visibility: 'public' });
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
    if (eventId) await db.delete(events).where(eq(events.id, eventId));
    if (publicSpaceId) {
      await db.delete(scans).where(eq(scans.spaceId, publicSpaceId));
      await db.delete(spaces).where(eq(spaces.id, publicSpaceId));
    }
    if (privateSpaceId) {
      await db.delete(scans).where(eq(scans.spaceId, privateSpaceId));
      await db.delete(spaces).where(eq(spaces.id, privateSpaceId));
    }
    if (ownerId) await db.delete(users).where(eq(users.id, ownerId)).catch(() => {});
    if (viewerId) await db.delete(users).where(eq(users.id, viewerId)).catch(() => {});
    await client.end();
    await rm(root, { recursive: true, force: true });
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});

test('real reconstruction multipart upload preserves bytes and metadata for public download', {
  skip: !process.env.TEST_DATABASE_URL || !process.env.REAL_SCAN_GLB_FILE,
}, async () => {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { db, client } = connectDatabase();
  const root = await mkdtemp(path.join(tmpdir(), 'path-app-real-scan-'));
  const storage = new LocalScanStorage(root);
  let ownerId: string | undefined;
  let spaceId: string | undefined;
  try {
    const bytes = await readFile(process.env.REAL_SCAN_GLB_FILE!);
    const suffix = randomUUID();
    const [owner] = await db.insert(users).values({ auth0Sub: `test|${suffix}`, username: `real_${suffix}`, displayName: 'Capture integration' }).returning();
    ownerId = owner.id;
    const [space] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Real room transport test', visibility: 'public' }).returning();
    spaceId = space.id;
    const form = new FormData();
    form.set('file', new File([bytes], path.basename(process.env.REAL_SCAN_GLB_FILE!)));
    form.set('name', 'Real reconstruction');
    form.set('visibility', 'public');
    form.set('transform', JSON.stringify(identityTransform));
    form.set('metadata', JSON.stringify({ integrationTest: true, scaleCalibrated: false }));
    const parsed = parseUpload(await boundedFormData(new Request('http://localhost/api/scans', { method: 'POST', body: form })));
    const scan = await createScan(db, storage, owner, space.id, parsed.input, new Uint8Array(await parsed.file.arrayBuffer()), parsed.file.name);
    assert.deepEqual(scan.transform, identityTransform);
    assert.equal(scan.metadata.scaleCalibrated, false);
    assert.equal(scan.byteSize, bytes.length);
    const downloaded = await downloadScan(db, storage, null, scan.id);
    const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
    assert.equal(sha256(downloaded.bytes), sha256(bytes));
    await updateScan(db, owner, scan.id, { visibility: 'private' });
    await assert.rejects(downloadScan(db, storage, null, scan.id), { status: 404 });
  } finally {
    if (spaceId) {
      await db.delete(scans).where(eq(scans.spaceId, spaceId));
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    }
    if (ownerId) await db.delete(users).where(eq(users.id, ownerId));
    await client.end();
    await rm(root, { recursive: true, force: true });
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});
