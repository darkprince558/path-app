import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { captures, processingJobs, scanRevisions, scans, spaces, users } from '../../db/schema';
import { canonicalJson, captureManifest } from '../capture/contract';
import { metricCoordinates, preservesMetricFrame, validatedMetricCapture } from '../processing/calibration';
import { CPU_PROCESSOR } from '../processing/selection';
import { CpuCaptureProcessor } from '../processing/cpu-processor';
import { MockCaptureProcessor } from '../processing/processor';
import { CaptureWorker } from '../processing/worker';
import { LocalCaptureStorage } from '../storage/captures';
import { LocalRevisionStorage } from '../storage/revisions';
import { LocalScanStorage } from '../storage';
import { ingestLidarFixture } from './fixtures/lidar-fixture';
import { approveRevision } from './revision-approval';
import { restoreCaptureCalibration } from './scan-calibration';
import { createScan, identityTransform, listScans, readScan, updateScan } from './scans';
import { shareMetadata, shareScene } from './shares';
import { readJob } from './jobs';
import { auth0 } from '../auth0';
import { POST as calibrationRoute } from '../../app/api/scans/[id]/calibration/route';

const native = new URL('../../../../../fixtures/lidar-native-capture/', import.meta.url);
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

test('metric provenance requires the real CPU identity, native frame, device and matching report, never alignment alone', async () => {
  // Synthetic geometry with simulated device metadata tests the contract, not real hardware.
  const manifest = captureManifest.parse(JSON.parse(await readFile(new URL('manifest.json', native), 'utf8')));
  manifest.device = { model: 'iPhone17,1', osVersion: 'Version 18.6 (Build 22G86)' };
  const report = { captureId: manifest.captureId, sourceManifestSha256: digest(manifest),
    coordinateSystem: manifest.coordinateSystem, entrancePose: manifest.entrancePose, masterTriangles: 200, sceneTriangles: 100, frames: [{}] };
  assert.equal(validatedMetricCapture(manifest, report, CPU_PROCESSOR, digest(manifest)), true);
  for (const [input, output, processor, hash] of [
    [manifest, report, { id: 'mock-lidar', version: '1' }, digest(manifest)],
    [manifest, report, { ...CPU_PROCESSOR, version: 'unknown' }, digest(manifest)],
    [manifest, { ...report, mock: true }, CPU_PROCESSOR, digest(manifest)],
    [manifest, { ...report, captureId: randomUUID() }, CPU_PROCESSOR, digest(manifest)],
    [manifest, { ...report, coordinateSystem: { units: 'relative' } }, CPU_PROCESSOR, digest(manifest)],
    [manifest, report, CPU_PROCESSOR, 'a'.repeat(64)],
    [{ ...manifest, device: { model: 'unknown (legacy scan)', osVersion: 'unknown' } }, report, CPU_PROCESSOR, digest(manifest)],
    [{ ...manifest, device: { model: 'synthetic wall fixture', osVersion: 'synthetic iOS' } }, report, CPU_PROCESSOR, digest(manifest)],
  ] as const) assert.equal(validatedMetricCapture(input, output, processor, hash), false);
  assert.equal(preservesMetricFrame(identityTransform), true);
  const yaw = [...identityTransform]; yaw[0] = yaw[10] = 0; yaw[2] = -1; yaw[8] = 1; yaw[13] = 9;
  assert.equal(preservesMetricFrame(yaw), true);
  for (const [index, value] of [[0, 2], [5, -1], [6, 0.1], [4, 0.1], [0, -1]]) {
    const matrix = [...identityTransform]; matrix[index] = value;
    assert.equal(preservesMetricFrame(matrix), false);
  }
});

test('metric CPU capture approval, owner repair, multi-scan verification and mock exclusions', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 60000,
}, async t => {
  const url = process.env.TEST_DATABASE_URL!;
  const previous = { DATABASE_URL: process.env.DATABASE_URL, CAPTURE_PROCESSOR: process.env.CAPTURE_PROCESSOR };
  process.env.DATABASE_URL = url; process.env.CAPTURE_PROCESSOR = 'cpu';
  const client = postgres(url, { max: 5, prepare: false }), db = drizzle(client);
  const root = await mkdtemp(path.join(tmpdir(), 'calibration-test-'));
  const source = new LocalCaptureStorage(path.join(root, 'captures')), revisions = new LocalRevisionStorage(path.join(root, 'revisions'));
  const storage = new LocalScanStorage(path.join(root, 'scans'));
  const cpu = new CpuCaptureProcessor({ databaseUrl: url, timeoutMs: 10000 });
  const mock = new MockCaptureProcessor();
  const worker = (processor = cpu as CpuCaptureProcessor | MockCaptureProcessor) => new CaptureWorker({ databaseUrl: url, captures: source, revisions, processor });
  const spaceIds: string[] = [], userIds: string[] = [];
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ keys: [{ ...await exportJWK(publicKey), alg: 'RS256', kid: 'calibration', use: 'sig' }] }));
  t.mock.method(auth0, 'getSession', async () => null);
  try {
    const suffix = randomUUID();
    const [owner, other] = await db.insert(users).values([
      { auth0Sub: `calibration|${suffix}`, username: `cal_${suffix}`, displayName: 'Owner' },
      { auth0Sub: `calibration-other|${suffix}`, username: `other_cal_${suffix}`, displayName: 'Other' },
    ]).returning(); userIds.push(owner.id, other.id);
    const [space, mockSpace] = await db.insert(spaces).values([
      { ownerId: owner.id, name: 'Metric capture', visibility: 'public', boundary: { coordinateSystem: metricCoordinates } },
      { ownerId: owner.id, name: 'Synthetic mock', visibility: 'public', boundary: { coordinateSystem: metricCoordinates } },
    ]).returning(); spaceIds.push(space.id, mockSpace.id);
    // The native fixture is deliberately synthetic. Simulate a declared iPhone bundle only in this temp directory.
    const input = path.join(root, 'simulated-iphone'); await cp(native, input, { recursive: true });
    const manifestPath = path.join(input, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.device = { model: 'iPhone17,1', osVersion: 'Version 18.6 (Build 22G86)' };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const fixture = new URL(`file://${input}/`);
    const queued = await ingestLidarFixture(db, source, owner, space.id, fixture);
    await worker().runOnce(queued.job.id);
    const job = await readJob(db, owner, queued.job.id); assert.equal(job.status, 'succeeded');
    const [revision] = await db.select().from(scanRevisions).where(eq(scanRevisions.id, job.revisionId!));
    assert.equal((revision.metadata.coordinateSystem as { calibrated: boolean }).calibrated, true);
    const first = await approveRevision(db, storage, revisions, owner, revision.id, { name: 'Metric iPhone', visibility: 'public' });
    const scan = first.scan;
    assert.deepEqual(scan.metadata.coordinateSystem, metricCoordinates);
    assert.equal(scan.metadata.alignmentVerified, true); assert.equal(scan.metadata.alignmentSource, 'single-capture');
    assert.deepEqual((await shareMetadata(db, null, scan.shareId)).metadata.coordinateSystem, metricCoordinates);
    assert.equal((await approveRevision(db, storage, revisions, owner, revision.id, { name: 'Retry' })).scan.id, scan.id);

    // Simulate the earlier bug through the supported owner PATCH, without editing immutable revisions.
    await updateScan(db, owner, scan.id, { metadata: { ...scan.metadata, alignmentVerified: true,
      coordinateSystem: { units: 'relative', upAxis: 'Y', calibrated: false } } });
    const token = (sub: string) => new SignJWT({ sub }).setProtectedHeader({ alg: 'RS256', kid: 'calibration' })
      .setIssuer(`https://${process.env.AUTH0_DOMAIN}/`).setAudience(process.env.AUTH0_AUDIENCE!).setExpirationTime('5m').sign(privateKey);
    const context = { params: Promise.resolve({ id: scan.id }) };
    const request = (authorization?: string) => new Request('http://localhost/calibration', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) }, body: '{}' });
    assert.equal((await calibrationRoute(request(), context)).status, 401);
    assert.equal((await calibrationRoute(request('invalid'), context)).status, 401);
    assert.equal((await calibrationRoute(request(await token(other.auth0Sub)), context)).status, 403);
    const restored = await calibrationRoute(request(await token(owner.auth0Sub)), context);
    assert.equal(restored.status, 200);
    assert.deepEqual((await restored.json()).scan.metadata.coordinateSystem, metricCoordinates);
    assert.equal((await shareMetadata(db, null, scan.shareId)).metadata.alignmentVerified, true);
    assert.deepEqual((await readScan(db, owner, scan.id)).transform, scan.transform);
    await updateScan(db, owner, scan.id, { visibility: 'private' });
    assert.equal((await calibrationRoute(request(await token(other.auth0Sub)), context)).status, 404);
    await assert.rejects(shareScene(db, storage, null, scan.shareId), { status: 404 });
    await updateScan(db, owner, scan.id, { visibility: 'public' });

    // Frame edits cannot carry an automatic calibration claim to a scaled/tilted export.
    const scaled = [...identityTransform]; scaled[0] = scaled[5] = scaled[10] = 2;
    await updateScan(db, owner, scan.id, { transform: scaled });
    assert.equal(((await readScan(db, owner, scan.id)).metadata.coordinateSystem as { calibrated: boolean }).calibrated, false);
    await assert.rejects(restoreCaptureCalibration(db, owner, scan.id), { status: 409 });
    await updateScan(db, owner, scan.id, { transform: identityTransform });
    await restoreCaptureCalibration(db, owner, scan.id);
    assert.equal((await readScan(db, owner, scan.id)).metadata.alignmentSource, 'single-capture');

    // A private second scan still makes a sole-scan alignment assertion insufficient for guests.
    const second = await createScan(db, storage, owner, space.id, { name: 'Unknown imported model', visibility: 'private', transform: identityTransform,
      metadata: { alignmentVerified: false } }, await readFile(new URL('source.glb', native)), 'import.glb');
    assert.equal((await shareMetadata(db, null, scan.shareId)).metadata.alignmentVerified, false);
    assert.equal((await listScans(db, null, space.id))[0].metadata.alignmentVerified, false);
    await assert.rejects(restoreCaptureCalibration(db, owner, second.id), { status: 409 });
    const another = await ingestLidarFixture(db, source, owner, space.id, fixture); await worker().runOnce(another.job.id);
    const next = await approveRevision(db, storage, revisions, owner, (await readJob(db, owner, another.job.id)).revisionId!, { name: 'Another iPhone' });
    assert.deepEqual(next.scan.metadata.coordinateSystem, metricCoordinates); assert.equal(next.scan.metadata.alignmentVerified, false);
    assert.equal((await restoreCaptureCalibration(db, owner, scan.id)).metadata.alignmentVerified, false);
    await updateScan(db, owner, scan.id, { metadata: { ...scan.metadata, coordinateSystem: metricCoordinates, alignmentVerified: true, alignmentSource: 'owner' } });
    assert.equal((await shareMetadata(db, null, scan.shareId)).metadata.alignmentVerified, true);

    process.env.CAPTURE_PROCESSOR = 'mock';
    const synthetic = await ingestLidarFixture(db, source, owner, mockSpace.id, fixture); await worker(mock).runOnce(synthetic.job.id);
    const mocked = await approveRevision(db, storage, revisions, owner, (await readJob(db, owner, synthetic.job.id)).revisionId!, { name: 'Mock LiDAR', alignmentVerified: true });
    assert.equal((mocked.scan.metadata.coordinateSystem as { calibrated: boolean }).calibrated, false);
    await assert.rejects(restoreCaptureCalibration(db, owner, mocked.scan.id), { status: 409 });
    // Explicit independent owner scale evidence is still supported, including for a synthetic test model.
    const confirmed = await updateScan(db, owner, mocked.scan.id, { metadata: { ...mocked.scan.metadata, coordinateSystem: metricCoordinates, alignmentVerified: true } });
    assert.deepEqual(confirmed.metadata.coordinateSystem, metricCoordinates);
  } finally {
    if (spaceIds.length) {
      await db.delete(scans).where(inArray(scans.spaceId, spaceIds));
      await db.delete(scanRevisions).where(inArray(scanRevisions.spaceId, spaceIds));
      const ids = (await db.select({ id: captures.id }).from(captures).where(inArray(captures.spaceId, spaceIds))).map(c => c.id);
      if (ids.length) await db.delete(processingJobs).where(inArray(processingJobs.captureId, ids));
      await db.delete(captures).where(inArray(captures.spaceId, spaceIds));
      await db.delete(spaces).where(inArray(spaces.id, spaceIds));
    }
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    await client.end(); await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
