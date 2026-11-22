import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { captures, captureFrames, eventMembers, events, eventSpaces, processingJobs, scanRevisions, spaces, users } from '../../db/schema';
import { canonicalJson, captureManifest, capturePath, validateFrameReferences, MAX_CAPTURE_JSON_BYTES } from '../capture/contract';
import { captureObjectKey, CaptureIntegrityError, LocalCaptureStorage } from '../storage/captures';
import { boundedCaptureJson, byteChunks, digestBytes, finalizeCapture, registerCapture, uploadCaptureFile } from './captures';
import { POST as registerRoute } from '../../app/api/captures/route';
import { POST as uploadRoute } from '../../app/api/captures/[captureId]/uploads/route';
import { POST as finalizeRoute } from '../../app/api/captures/[captureId]/finalize/route';
import { GET as jobRoute } from '../../app/api/jobs/[jobId]/route';

const fixture = new URL('../../../../../fixtures/lidar-capture/', import.meta.url);
const fixtureFile = (name: string) => readFile(new URL(name, fixture));
const fixtureManifest = async () => captureManifest.parse(JSON.parse((await fixtureFile('manifest.json')).toString()));
const fixtureFrames = async () => JSON.parse((await fixtureFile('frames.json')).toString());
const uploadRequest = (filePath: string, bytes: Uint8Array, extra: Record<string, string> = {}) =>
  new Request(`http://localhost/api/captures/unused/uploads?path=${encodeURIComponent(filePath)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...extra }, body: Buffer.from(bytes),
  });

test('synthetic bundle validates every size, checksum and stable frame reference', async () => {
  const manifest = await fixtureManifest();
  for (const file of manifest.files) assert.deepEqual(digestBytes(await fixtureFile(file.path)), {
    byteSize: file.byteSize, sha256: file.sha256,
  });
  const frames = validateFrameReferences(await fixtureFrames(), manifest);
  assert.equal(frames.frames[0].id, 'junction-02');
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(canonicalJson(reordered), canonicalJson(manifest));
});

test('manifest rejects unsafe paths, missing/duplicate files, limits and invalid matrices', async () => {
  const manifest = await fixtureManifest();
  for (const value of ['../source.glb', '/source.glb', 'frames/../source.glb', 'frames\\x.jpg',
    'frames/%2e%2e/x.jpg', 'frames//x.jpg', './points.ply', 'https://host/x.jpg', 'frames/a.jpg\n',
    'frames/a.jpg\0', 'frames/a.JPG', 'manifest.json']) {
    assert.equal(capturePath.safeParse(value).success, false, value);
  }
  for (const files of [manifest.files.slice(1), [...manifest.files, manifest.files[0]],
    manifest.files.map(file => ({ ...file, byteSize: 0 })),
    manifest.files.map(file => ({ ...file, sha256: 'not-a-checksum' })),
    manifest.files.map(file => ({ ...file, sha256: `${file.sha256}\n` })),
    manifest.files.map(file => ({ ...file, byteSize: 33 * 1024 * 1024 }))]) {
    assert.equal(captureManifest.safeParse({ ...manifest, files }).success, false);
  }
  const perspective = [...manifest.entrancePose]; perspective[3] = 1;
  for (const entrancePose of [[1, 2], perspective, manifest.entrancePose.map(() => 0)]) {
    assert.equal(captureManifest.safeParse({ ...manifest, entrancePose }).success, false);
  }
  const largeFrames = manifest.files.map(file => file.path === 'frames.json'
    ? { ...file, byteSize: MAX_CAPTURE_JSON_BYTES + 1 } : file);
  assert.equal(captureManifest.safeParse({ ...manifest, files: largeFrames }).success, false);
  const tooManyBytes = [...manifest.files, ...Array.from({ length: 9 }, (_, i) => ({
    path: `frames/extra-${i}.jpg`, byteSize: 32 * 1024 * 1024, sha256: 'a'.repeat(64),
  }))];
  assert.equal(captureManifest.safeParse({ ...manifest, files: tooManyBytes }).success, false);
});

test('frame JSON rejects duplicate IDs, dangling/unreferenced images, foreign captures and invalid poses', async () => {
  const manifest = await fixtureManifest();
  const index = await fixtureFrames();
  for (const invalid of [
    { ...index, captureId: randomUUID() },
    { ...index, frames: [...index.frames, index.frames[0]] },
    { ...index, frames: [] },
    { ...index, frames: [{ ...index.frames[0], imagePath: 'preview.jpg' }] },
    { ...index, frames: [{ ...index.frames[0], id: 'unknown', imagePath: 'frames/unknown.jpg' }] },
    { ...index, frames: [{ ...index.frames[0], cameraPose: [1, 2] }] },
    { ...index, frames: [{ ...index.frames[0], width: 0 }] },
  ]) assert.throws(() => validateFrameReferences(invalid, manifest));
  assert.throws(() => validateFrameReferences(index, { ...manifest, files: [...manifest.files,
    { path: 'frames/unreferenced.jpg', byteSize: 1, sha256: 'a'.repeat(64) }] }));
});

test('registration JSON is bounded even without Content-Length', async () => {
  const request = (body: string, headers: Record<string, string> = {}) => new Request('http://localhost', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers },
  });
  await assert.rejects(boundedCaptureJson(request(' '.repeat(MAX_CAPTURE_JSON_BYTES + 1))), { status: 413 });
  await assert.rejects(boundedCaptureJson(request('{}', { 'Content-Length': String(MAX_CAPTURE_JSON_BYTES + 1) })), { status: 413 });
  await assert.rejects(boundedCaptureJson(request('{')), { status: 400 });
  await assert.rejects(boundedCaptureJson(request('{}', { 'Content-Type': 'text/plain' })), { status: 400 });
});

test('private local storage is atomic, immutable, bounded, retryable and rejects symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lidar-storage-'));
  const storage = new LocalCaptureStorage(root);
  const key = captureObjectKey(randomUUID(), 'source.glb');
  const bytes = await fixtureFile('source.glb');
  const expected = digestBytes(bytes);
  try {
    await assert.rejects(storage.putVerified(key, byteChunks(bytes.subarray(1)), expected), CaptureIntegrityError);
    assert.equal(await storage.inspect(key), null);
    await assert.rejects(storage.putVerified(key, byteChunks(Buffer.concat([bytes, bytes])), expected), CaptureIntegrityError);
    await assert.rejects(storage.putVerified(key, byteChunks(bytes), { ...expected, sha256: '0'.repeat(64) }), CaptureIntegrityError);
    async function* interrupted() { yield bytes.subarray(0, 10); throw new Error('Disconnected uploader'); }
    await assert.rejects(storage.putVerified(key, interrupted(), expected), /Disconnected uploader/);
    assert.deepEqual(await readdir(path.dirname(path.join(root, key))), []);
    await storage.putVerified(key, byteChunks(bytes), expected);
    await storage.putVerified(key, byteChunks(bytes), expected);
    assert.deepEqual(await storage.inspect(key), expected);
    assert.deepEqual(await storage.read(key, bytes.length), bytes);
    assert.equal((await stat(path.join(root, key))).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(path.join(root, key)))).mode & 0o777, 0o700);
    const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    await assert.rejects(storage.putVerified(key, byteChunks(changed), digestBytes(changed)), CaptureIntegrityError);
    await assert.rejects(storage.read(key, 1), CaptureIntegrityError);
    await assert.rejects(storage.inspect('captures/../../leak'));
    const linkKey = captureObjectKey(key.split('/')[1], 'preview.jpg');
    await symlink(path.join(root, key), path.join(root, linkKey));
    await assert.rejects(storage.inspect(linkKey));
    const nestedKey = captureObjectKey(key.split('/')[1], 'frames/junction-02.jpg');
    await symlink(root, path.join(root, 'captures', key.split('/')[1], 'frames'));
    await assert.rejects(storage.putVerified(nestedKey, byteChunks(bytes), expected));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('all ingestion endpoints reject invalid bearer tokens before reading bodies or storage', async () => {
  const context = { params: Promise.resolve({ captureId: randomUUID() }) };
  const request = () => new Request('http://localhost/api/captures', {
    method: 'POST', headers: { Authorization: 'Bearer invalid' },
  });
  for (const response of [await registerRoute(request()), await uploadRoute(request(), context),
    await finalizeRoute(request(), context), await jobRoute(request(), { params: Promise.resolve({ jobId: randomUUID() }) })]) assert.equal(response.status, 401);
});

test('capture ingestion verifies a whole bundle, protects owners and survives retries/restarts', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 5, prepare: false });
  const db = drizzle(client);
  const root = await mkdtemp(path.join(tmpdir(), 'lidar-ingestion-'));
  const storage = new LocalCaptureStorage(root);
  const suffix = randomUUID();
  let ownerId: string | undefined;
  let viewerId: string | undefined;
  let spaceId: string | undefined;
  let eventId: string | undefined;
  try {
    const [owner, viewer] = await db.insert(users).values([
      { auth0Sub: `ingestion|${suffix}`, username: `ingestion_${suffix}`, displayName: 'Owner' },
      { auth0Sub: `viewer|${suffix}`, username: `viewer_${suffix}`, displayName: 'Viewer' },
    ]).returning();
    ownerId = owner.id; viewerId = viewer.id;
    const [space] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Capture space', visibility: 'private' }).returning();
    spaceId = space.id;
    const manifest = await fixtureManifest();
    const value = { spaceId: space.id, manifest };
    const registrations = await Promise.all([registerCapture(db, storage, owner, value), registerCapture(db, storage, owner, value)]);
    const { capture } = registrations[0];
    assert.equal(registrations[1].capture.id, capture.id);
    assert.deepEqual(registrations.map(r => r.created).sort(), [false, true]);
    assert.equal('bundleObjectPrefix' in capture, false);
    await assert.rejects(registerCapture(db, storage, owner, {
      ...value, manifest: { ...manifest, trackingWarnings: ['different'] },
    }), { status: 409 });
    await assert.rejects(finalizeCapture(db, storage, owner, capture.id), { status: 409 });
    assert.deepEqual(await db.select().from(captureFrames).where(eq(captureFrames.captureId, capture.id)), []);
    // Even event membership, a public parent, or knowledge of a capture ID does not authorize raw ingestion.
    const [event] = await db.insert(events).values({ ownerId: owner.id, name: 'Capture access test' }).returning();
    eventId = event.id;
    await db.insert(eventSpaces).values({ eventId: event.id, spaceId: space.id });
    await db.insert(eventMembers).values({ eventId: event.id, userId: viewer.id });
    await assert.rejects(registerCapture(db, storage, viewer, value));
    await assert.rejects(uploadCaptureFile(db, storage, viewer, capture.id, uploadRequest('source.glb', await fixtureFile('source.glb'))), { status: 404 });
    await assert.rejects(finalizeCapture(db, storage, viewer, capture.id), { status: 404 });
    await db.update(spaces).set({ visibility: 'public' }).where(eq(spaces.id, space.id));
    await assert.rejects(registerCapture(db, storage, viewer, value));
    await assert.rejects(finalizeCapture(db, storage, viewer, capture.id), { status: 404 });
    const bytes = await fixtureFile('source.glb');
    await assert.rejects(uploadCaptureFile(db, storage, owner, capture.id, uploadRequest('../source.glb', bytes)));
    await assert.rejects(uploadCaptureFile(db, storage, owner, capture.id, uploadRequest('frames/unknown.jpg', bytes)), { status: 400 });
    await assert.rejects(uploadCaptureFile(db, storage, owner, capture.id, uploadRequest('source.glb', bytes, { 'Content-Length': '1' })), { status: 400 });
    const changed = Buffer.from(bytes); changed[0] ^= 1;
    await assert.rejects(uploadCaptureFile(db, storage, owner, capture.id, uploadRequest('source.glb', changed)), { status: 400 });
    assert.equal(await storage.inspect(captureObjectKey(capture.id, 'source.glb')), null);
    await assert.rejects(uploadCaptureFile(db, storage, owner, capture.id, uploadRequest('source.glb', bytes.subarray(1))), { status: 400 });
    await assert.rejects(uploadCaptureFile(db, storage, owner, capture.id, uploadRequest('source.glb', Buffer.concat([bytes, bytes]))), { status: 400 });
    for (const file of manifest.files) {
      const result = await uploadCaptureFile(db, storage, owner, capture.id, uploadRequest(file.path, await fixtureFile(file.path)));
      assert.equal(result.sha256, file.sha256);
    }
    await uploadCaptureFile(db, storage, owner, capture.id, uploadRequest('source.glb', bytes));
    // Finalize must hash stored bytes again instead of trusting successful upload responses.
    const previewKey = captureObjectKey(capture.id, 'preview.jpg');
    await writeFile(path.join(root, previewKey), Buffer.from('corrupt'));
    await assert.rejects(finalizeCapture(db, storage, owner, capture.id), { status: 409 });
    await writeFile(path.join(root, previewKey), await fixtureFile('preview.jpg'));
    const freshStorage = new LocalCaptureStorage(root);
    const results = await Promise.all([finalizeCapture(db, freshStorage, owner, capture.id), finalizeCapture(db, freshStorage, owner, capture.id)]);
    assert.equal(results[0].capture.status, 'uploaded');
    assert.deepEqual(results[0], results[1]);
    const frames = await db.select().from(captureFrames).where(eq(captureFrames.captureId, capture.id));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].frameId, 'junction-02');
    assert.equal(frames[0].sha256, manifest.files.find(file => file.path === 'frames/junction-02.jpg')!.sha256);
    const jobs = await db.select().from(processingJobs).where(eq(processingJobs.captureId, capture.id));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'queued');
    assert.equal(results[0].job.id, jobs[0].id);
    assert.deepEqual(await db.select().from(scanRevisions).where(eq(scanRevisions.captureId, capture.id)), []);
    await assert.rejects(uploadCaptureFile(db, storage, owner, capture.id, uploadRequest('source.glb', bytes)), { status: 409 });
    assert.equal((await registerCapture(db, freshStorage, owner, value)).capture.status, 'uploaded');
  } finally {
    if (eventId) await db.delete(events).where(eq(events.id, eventId));
    if (spaceId) {
      const rows = await db.select({ id: captures.id }).from(captures).where(eq(captures.spaceId, spaceId));
      for (const row of rows) await db.delete(processingJobs).where(eq(processingJobs.captureId, row.id));
      await db.delete(captures).where(eq(captures.spaceId, spaceId));
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    }
    if (ownerId) await db.delete(users).where(eq(users.id, ownerId));
    if (viewerId) await db.delete(users).where(eq(users.id, viewerId));
    await client.end();
    await rm(root, { recursive: true, force: true });
  }
});

test('authenticated route handlers ingest the fixture through Auth0 JWT verification and real PostgreSQL', {
  skip: !process.env.TEST_DATABASE_URL,
}, async t => {
  const previousDatabase = process.env.DATABASE_URL;
  const previousStorage = process.env.CAPTURE_STORAGE_DIR;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 2, prepare: false });
  const db = drizzle(client);
  const root = await mkdtemp(path.join(tmpdir(), 'lidar-routes-'));
  process.env.CAPTURE_STORAGE_DIR = root;
  const suffix = randomUUID();
  let ownerId: string | undefined;
  let spaceId: string | undefined;
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const issuer = `https://${process.env.AUTH0_DOMAIN}/`;
  const jwks = { keys: [{ ...await exportJWK(publicKey), alg: 'RS256', use: 'sig', kid: 'capture-test' }] };
  // Replace only the external JWKS response; signatures, issuer/audience checks and user sync run normally.
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    assert.equal(String(url), `${issuer}.well-known/jwks.json`);
    return Response.json(jwks);
  });
  try {
    const sub = `capture-routes|${suffix}`;
    const [owner] = await db.insert(users).values({ auth0Sub: sub, username: `routes_${suffix}`, displayName: 'Owner' }).returning();
    ownerId = owner.id;
    const [space] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Route ingestion fixture' }).returning();
    spaceId = space.id;
    const token = await new SignJWT({ sub }).setProtectedHeader({ alg: 'RS256', kid: 'capture-test' })
      .setIssuer(issuer).setAudience(process.env.AUTH0_AUDIENCE!).setExpirationTime('5m').sign(privateKey);
    const headers = { Authorization: `Bearer ${token}` };
    const register = () => registerRoute(new Request('http://localhost/api/captures', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaceId: space.id, manifest }),
    }));
    const manifest = await fixtureManifest();
    const created = await register();
    assert.equal(created.status, 201);
    const { capture } = await created.json();
    const context = { params: Promise.resolve({ captureId: capture.id }) };
    assert.equal((await register()).status, 200);
    const finalize = () => finalizeRoute(new Request(`http://localhost/api/captures/${capture.id}/finalize`, {
      method: 'POST', headers,
    }), context);
    assert.equal((await finalize()).status, 409);
    const invalid = await uploadRoute(uploadRequest('frames/unknown.jpg', Buffer.from('x'), headers), context);
    assert.equal(invalid.status, 400);
    for (const file of manifest.files) {
      const response = await uploadRoute(uploadRequest(file.path, await fixtureFile(file.path), headers), context);
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
    }
    const finalized = await finalize();
    assert.equal(finalized.status, 200);
    const finalizedBody = await finalized.json();
    assert.equal(finalizedBody.capture.status, 'uploaded');
    const jobResponse = await jobRoute(new Request(`http://localhost${finalizedBody.job.statusPath}`, { headers }),
      { params: Promise.resolve({ jobId: finalizedBody.job.id }) });
    assert.equal(jobResponse.status, 200);
    assert.equal(jobResponse.headers.get('cache-control'), 'private, no-store');
    const job = (await jobResponse.json()).job;
    assert.equal(job.status, 'queued');
    assert.equal(job.revisionId, null);
    assert.equal('leaseToken' in job, false);
    assert.equal('configuration' in job, false);
    assert.equal((await finalize()).status, 200);
    assert.equal((await uploadRoute(uploadRequest('source.glb', await fixtureFile('source.glb'), headers), context)).status, 409);
    const frames = await db.select().from(captureFrames).where(eq(captureFrames.captureId, capture.id));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].frameId, 'junction-02');
  } finally {
    if (spaceId) {
      const rows = await db.select({ id: captures.id }).from(captures).where(eq(captures.spaceId, spaceId));
      for (const row of rows) await db.delete(processingJobs).where(eq(processingJobs.captureId, row.id));
      await db.delete(captures).where(eq(captures.spaceId, spaceId));
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    }
    if (ownerId) await db.delete(users).where(eq(users.id, ownerId));
    await client.end();
    await rm(root, { recursive: true, force: true });
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (previousStorage === undefined) delete process.env.CAPTURE_STORAGE_DIR;
    else process.env.CAPTURE_STORAGE_DIR = previousStorage;
  }
});
