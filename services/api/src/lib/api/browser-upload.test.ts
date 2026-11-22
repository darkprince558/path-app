import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { auth0 } from '../auth0';
import { GET as metadataRoute } from '../../app/api/shares/[shareId]/route';
import { GET as sceneRoute } from '../../app/api/shares/[shareId]/scene/route';
import { connectDatabase } from '../../db/client';
import { scans, scanViewers, spaces, users } from '../../db/schema';
import { POST } from '../../app/api/scans/route';
import { LocalScanStorage } from '../storage';
import { createBrowserScan, parseBrowserUpload } from './browser-upload';
import { deleteScan, downloadScan, MAX_GLB_BYTES, updateScan } from './scans';
import { shareMetadata, shareScene } from './shares';
import { listMyScans, listPublicScans } from './scan-lists';
import { listSpaces } from './access';

const fixture = () => readFile(new URL('../../../../../fixtures/venue/sample-triangle.glb', import.meta.url));
const request = (bytes: Uint8Array, query = 'format=glb&visibility=unlisted&name=Hallway') =>
  new Request(`http://localhost/api/scans?${query}`, { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' }, body: Uint8Array.from(bytes) });

test('browser upload accepts the website request and bounds raw bodies', async () => {
  const bytes = await fixture();
  const parsed = await parseBrowserUpload(request(bytes));
  assert.deepEqual(parsed.input, { name: 'Hallway', visibility: 'unlisted' });
  assert.deepEqual(parsed.bytes, bytes);
  assert.equal((await parseBrowserUpload(request(bytes, 'format=glb'))).input.visibility, 'private');
  await assert.rejects(parseBrowserUpload(request(bytes, 'format=ply')), { status: 415 });
  await assert.rejects(parseBrowserUpload(request(Buffer.from('bad'))), { status: 400 });
  await assert.rejects(parseBrowserUpload(request(bytes, 'format=glb&visibility=unknown')));
  const oversized = request(bytes);
  oversized.headers.set('content-length', String(MAX_GLB_BYTES + 1));
  await assert.rejects(parseBrowserUpload(oversized), { status: 413 });
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_GLB_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close();
  } });
  await assert.rejects(parseBrowserUpload(new Request('http://localhost/api/scans?format=glb', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: stream, duplex: 'half',
  } as RequestInit)), { status: 413 });
  const unauthorized = request(bytes);
  unauthorized.headers.set('Authorization', 'Bearer invalid');
  assert.equal((await POST(unauthorized)).status, 401);
});

test('browser import supports all sharing modes, grants, revocation and rollback', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { db, client } = connectDatabase();
  const root = await mkdtemp(path.join(tmpdir(), 'browser-upload-'));
  const storage = new LocalScanStorage(root);
  const ownerIds: string[] = [];
  const spaceIds: string[] = [];
  try {
    const suffix = randomUUID();
    const [owner, viewer] = await db.insert(users).values(['owner', 'viewer'].map(role => ({
      auth0Sub: `test|browser|${suffix}|${role}`, username: `${suffix}_${role}`, displayName: role,
    }))).returning();
    ownerIds.push(owner.id, viewer.id);
    const bytes = await fixture();
    const input = (await parseBrowserUpload(request(bytes))).input;
    const scan = await createBrowserScan(db, storage, owner, input, bytes);
    spaceIds.push(scan.spaceId);
    assert.deepEqual(await shareScene(db, storage, null, scan.shareId), bytes);
    assert.equal((await shareMetadata(db, null, scan.shareId)).name, 'Hallway');
    assert.equal((await listPublicScans(db)).some(s => s.shareId === scan.shareId), false);
    assert.equal((await listSpaces(db, null)).some(s => s.id === scan.spaceId), false);
    assert.equal((await listMyScans(db, owner)).find(s => s.id === scan.id)?.visibility, 'unlisted');
    await assert.rejects(updateScan(db, viewer, scan.id, { visibility: 'public' }), { status: 403 });
    await updateScan(db, owner, scan.id, { visibility: 'public' });
    assert.equal((await listPublicScans(db)).some(s => s.shareId === scan.shareId), true);
    assert.deepEqual(await shareScene(db, storage, null, scan.shareId), bytes);
    await updateScan(db, owner, scan.id, { visibility: 'private' });
    await assert.rejects(shareMetadata(db, null, scan.shareId), { status: 404 });
    await assert.rejects(shareScene(db, storage, null, scan.shareId), { status: 404 });
    await assert.rejects(downloadScan(db, storage, viewer, scan.id), { status: 404 });
    await db.insert(scanViewers).values({ scanId: scan.id, userId: viewer.id });
    assert.deepEqual(await shareScene(db, storage, viewer, scan.shareId), bytes);
    await db.delete(scanViewers).where(eq(scanViewers.scanId, scan.id));
    await assert.rejects(shareScene(db, storage, viewer, scan.shareId), { status: 404 });
    await updateScan(db, owner, scan.id, { visibility: 'unlisted' });
    assert.deepEqual(await shareScene(db, storage, null, scan.shareId), bytes);
    await deleteScan(db, storage, owner, scan.id);
    await assert.rejects(shareScene(db, storage, null, scan.shareId), { status: 404 });

    const written: string[] = [], deleted: string[] = [];
    await assert.rejects(createBrowserScan(db, {
      ...storage, put: async key => { written.push(key); }, delete: async key => { deleted.push(key); },
      get: key => storage.get(key), exists: key => storage.exists(key),
    }, { ...owner, id: randomUUID() }, input, bytes));
    assert.deepEqual(deleted, written);
    assert.equal((await listMyScans(db, owner)).some(s => s.id === scan.id), false);
  } finally {
    for (const id of spaceIds) {
      await db.delete(scans).where(eq(scans.spaceId, id));
      await db.delete(spaces).where(eq(spaces.id, id));
    }
    for (const id of ownerIds) await db.delete(users).where(eq(users.id, id));
    await client.end();
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});


test('signed browser upload route returns a working signed-out model link', {
  skip: !process.env.TEST_DATABASE_URL,
}, async t => {
  const previousDatabase = process.env.DATABASE_URL;
  const previousStorage = process.env.SCAN_STORAGE_DIR;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { db, client } = connectDatabase();
  const root = await mkdtemp(path.join(tmpdir(), 'browser-upload-route-'));
  process.env.SCAN_STORAGE_DIR = root;
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  t.mock.method(auth0, 'getSession', async () => null);
  const issuer = `https://${process.env.AUTH0_DOMAIN}/`;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    assert.equal(String(url), `${issuer}.well-known/jwks.json`);
    return Response.json({ keys: [{ ...await exportJWK(publicKey), alg: 'RS256', use: 'sig', kid: 'upload-test' }] });
  });
  let ownerId: string | undefined;
  let spaceId: string | undefined;
  try {
    const suffix = randomUUID();
    const sub = `browser-upload|${suffix}`;
    const [owner] = await db.insert(users).values({ auth0Sub: sub, username: suffix, displayName: 'Upload test' }).returning();
    ownerId = owner.id;
    const token = await new SignJWT({ sub }).setProtectedHeader({ alg: 'RS256', kid: 'upload-test' })
      .setIssuer(issuer).setAudience(process.env.AUTH0_AUDIENCE!).setExpirationTime('5m').sign(privateKey);
    const bytes = process.env.REAL_SCAN_GLB_FILE ? await readFile(process.env.REAL_SCAN_GLB_FILE) : await fixture();
    const upload = request(bytes);
    upload.headers.set('Authorization', `Bearer ${token}`);
    const response = await POST(upload);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.name, 'Hallway');
    assert.equal(result.sharePath, `/s/${result.shareId}`);
    const [scan] = await db.select().from(scans).where(eq(scans.id, result.id));
    spaceId = scan.spaceId;
    const context = { params: Promise.resolve({ shareId: result.shareId }) };
    const metadataResponse = await metadataRoute(new Request(`http://localhost/api/shares/${result.shareId}`), context);
    assert.equal(metadataResponse.status, 200);
    const meta = await metadataResponse.json();
    const asset = await sceneRoute(new Request(`http://localhost${meta.assetPath}`), context);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('Cache-Control'), 'private, no-cache'); assert.ok(asset.headers.get('ETag'));
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), bytes);
  } finally {
    if (spaceId) {
      await db.delete(scans).where(eq(scans.spaceId, spaceId));
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    }
    if (ownerId) await db.delete(users).where(eq(users.id, ownerId));
    await client.end();
    await rm(root, { recursive: true, force: true });
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousStorage === undefined) delete process.env.SCAN_STORAGE_DIR; else process.env.SCAN_STORAGE_DIR = previousStorage;
  }
});
