import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { captures, navEdges, navNodes, paths, pathWaypoints, processingJobs, scanRevisions, scans, scanViewers, spaces, users } from '../../db/schema';
import { LocalScanStorage } from '../storage';
import { LocalCaptureStorage } from '../storage/captures';
import { LocalRevisionStorage } from '../storage/revisions';
import { CaptureWorker } from '../processing/worker';
import { MockCaptureProcessor, ProcessingFailure } from '../processing/processor';
import { auth0 } from '../auth0';
import { ingestLidarFixture, lidarFixtureFile } from './fixtures/lidar-fixture';
import { approveRevision } from './revision-approval';
import { createScan, downloadScan, identityTransform, updateScan } from './scans';
import { readJob } from './jobs';
import { shareFrame, shareMetadata, sharePoints, shareScene } from './shares';
import { POST as approveRoute } from '../../app/api/scan-revisions/[revisionId]/approve/route';
import { GET as metadataRoute } from '../../app/api/shares/[shareId]/route';
import { GET as sceneRoute } from '../../app/api/shares/[shareId]/scene/route';
import { GET as pointsRoute } from '../../app/api/shares/[shareId]/points/route';
import { GET as frameRoute } from '../../app/api/shares/[shareId]/frames/[frameId]/route';

test('approval and sharing preserve revision integrity, privacy, transforms and existing scans/routes', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 30000,
}, async t => {
  const previous = { DATABASE_URL: process.env.DATABASE_URL, SCAN_STORAGE_DIR: process.env.SCAN_STORAGE_DIR,
    CAPTURE_STORAGE_DIR: process.env.CAPTURE_STORAGE_DIR, REVISION_STORAGE_DIR: process.env.REVISION_STORAGE_DIR };
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 5, prepare: false }); const db = drizzle(client);
  const root = await mkdtemp(path.join(tmpdir(), 'publishing-test-'));
  Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, SCAN_STORAGE_DIR: path.join(root, 'scans'),
    CAPTURE_STORAGE_DIR: path.join(root, 'captures'), REVISION_STORAGE_DIR: path.join(root, 'revisions') });
  const storage = new LocalScanStorage(process.env.SCAN_STORAGE_DIR!);
  const source = new LocalCaptureStorage(process.env.CAPTURE_STORAGE_DIR!);
  const revisions = new LocalRevisionStorage(process.env.REVISION_STORAGE_DIR!);
  const processor = new MockCaptureProcessor();
  const worker = (failing = false) => new CaptureWorker({ databaseUrl: process.env.TEST_DATABASE_URL!, captures: source,
    revisions, processor: failing ? { id: processor.id, version: processor.version,
      async process() { throw new ProcessingFailure('TEST_FAILURE', 'Synthetic failure'); } } : processor });
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const issuer = `https://${process.env.AUTH0_DOMAIN}/`;
  const jwks = { keys: [{ ...await exportJWK(publicKey), alg: 'RS256', kid: 'approval-test', use: 'sig' }] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(jwks));
  t.mock.method(auth0, 'getSession', async () => null);
  let ownerId: string | undefined, viewerId: string | undefined;
  const spaceIds: string[] = [];
  try {
    const suffix = randomUUID();
    const [owner, viewer] = await db.insert(users).values([
      { auth0Sub: `publish|${suffix}`, username: `publish_${suffix}`, displayName: 'Owner' },
      { auth0Sub: `publish-viewer|${suffix}`, username: `publish_viewer_${suffix}`, displayName: 'Viewer' },
    ]).returning(); ownerId = owner.id; viewerId = viewer.id;
    const [space, privateSpace] = await db.insert(spaces).values([
      { ownerId: owner.id, name: 'Public fixture', visibility: 'public', boundary: { coordinateSystem: { units: 'metres', upAxis: 'Y', calibrated: true } } },
      { ownerId: owner.id, name: 'Private fixture', visibility: 'private' },
    ]).returning(); spaceIds.push(space.id, privateSpace.id);
    const token = async (sub: string) => new SignJWT({ sub }).setProtectedHeader({ alg: 'RS256', kid: 'approval-test' })
      .setIssuer(issuer).setAudience(process.env.AUTH0_AUDIENCE!).setExpirationTime('5m').sign(privateKey);
    const ownerHeaders = { Authorization: `Bearer ${await token(owner.auth0Sub)}` };
    const viewerHeaders = { Authorization: `Bearer ${await token(viewer.auth0Sub)}` };
    const request = (headers: Record<string, string> = {}) => new Request('http://localhost/test', { headers });
    const queued = await ingestLidarFixture(db, source, owner, space.id);
    await worker().runOnce(queued.job.id);
    const job = await readJob(db, owner, queued.job.id); const revisionId = job.revisionId!;
    const revisionContext = { params: Promise.resolve({ revisionId }) };
    const approvalBody = { name: 'Approved triangle', visibility: 'public' as const,
      transform: [2,0,0,0, 0,2,0,0, 0,0,2,0, 3,0,-2,1],
      coordinateSystem: { units: 'metres' as const, upAxis: 'Y' as const, calibrated: true }, alignmentVerified: true };
    const approveRequest = (headers: Record<string, string>) => new Request('http://localhost/approve', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(approvalBody),
    });
    assert.equal((await approveRoute(approveRequest({ Authorization: 'Bearer invalid' }), revisionContext)).status, 401);
    assert.equal((await approveRoute(approveRequest(viewerHeaders), revisionContext)).status, 404);
    const first = await approveRoute(approveRequest(ownerHeaders), revisionContext);
    assert.equal(first.status, 201);
    const approved = await first.json(); const scan = approved.scan;
    assert.equal(scan.sourceRevisionId, revisionId);
    assert.deepEqual(scan.transform, approvalBody.transform);
    assert.deepEqual(scan.metadata.coordinateSystem, approvalBody.coordinateSystem);
    assert.equal(scan.metadata.processing.mock, true);
    assert.equal('objectKey' in scan, false);
    const retry = await approveRoute(approveRequest(ownerHeaders), revisionContext);
    assert.equal(retry.status, 200); assert.equal((await retry.json()).scan.id, scan.id);
    const [immutable] = await db.select().from(scanRevisions).where(eq(scanRevisions.id, revisionId));
    assert.equal(immutable.scanId, null); assert.equal(immutable.status, 'approved');
    assert.deepEqual(immutable.transform, identityTransform);
    assert.equal(immutable.approvedBy, owner.id);
    const context = { params: Promise.resolve({ shareId: scan.shareId }) };
    const metaResponse = await metadataRoute(request(), context);
    assert.equal(metaResponse.status, 200);
    const meta = await metaResponse.json();
    assert.equal(meta.assetPath, `/api/shares/${scan.shareId}/scene`);
    assert.equal(meta.revisionId, revisionId); assert.deepEqual(meta.transform, approvalBody.transform);
    assert.equal('frames' in meta, false); assert.equal('objectKey' in meta, false);
    const glb = await sceneRoute(request(), context);
    assert.equal(glb.status, 200); assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(glb.headers.get('cache-control'), 'private, no-cache'); assert.ok(glb.headers.get('etag'));
    assert.deepEqual(Buffer.from(await glb.arrayBuffer()), await lidarFixtureFile('source.glb'));
    assert.equal((await pointsRoute(request(), context)).status, 200);
    const frameContext = { params: Promise.resolve({ shareId: scan.shareId, frameId: 'junction-02' }) };
    assert.equal((await frameRoute(request(), frameContext)).status, 404);
    assert.equal((await frameRoute(request(viewerHeaders), frameContext)).status, 404);
    const frame = await frameRoute(request(ownerHeaders), frameContext);
    assert.equal(frame.status, 200); assert.deepEqual(Buffer.from(await frame.arrayBuffer()), await lidarFixtureFile('frames/junction-02.jpg'));
    await assert.rejects(shareFrame(db, source, owner, scan.shareId, '../manifest.json'), { status: 404 });
    await assert.rejects(revisions.readVerified(revisionId, '../report.json', { byteSize: 1, sha256: 'a'.repeat(64) }));

    // Visibility changes apply to metadata and every direct byte URL on the next request.
    await updateScan(db, owner, scan.id, { visibility: 'private' });
    assert.equal((await metadataRoute(request(), context)).status, 404);
    assert.equal((await sceneRoute(request(), context)).status, 404);
    assert.equal((await pointsRoute(request(), context)).status, 404);
    assert.equal((await sceneRoute(request(ownerHeaders), context)).status, 200);
    await db.insert(scanViewers).values({ scanId: scan.id, userId: viewer.id });
    assert.equal((await sceneRoute(request(viewerHeaders), context)).status, 200);
    assert.equal((await frameRoute(request(viewerHeaders), frameContext)).status, 404);
    await db.delete(scanViewers).where(eq(scanViewers.scanId, scan.id));
    assert.equal((await sceneRoute(request(viewerHeaders), context)).status, 404);
    await updateScan(db, owner, scan.id, { visibility: 'public' });
    await db.update(spaces).set({ visibility: 'private' }).where(eq(spaces.id, space.id));
    assert.equal((await metadataRoute(request(), context)).status, 404);
    assert.equal((await sceneRoute(request(), context)).status, 404);
    await db.update(spaces).set({ visibility: 'public' }).where(eq(spaces.id, space.id));

    // No approval can publish incomplete output or a failed job.
    const pending = await ingestLidarFixture(db, source, owner, space.id);
    await worker(true).runOnce(pending.job.id);
    const [failedRevision] = await db.insert(scanRevisions).values({ captureId: pending.capture.id, spaceId: space.id,
      processingJobId: pending.job.id, revision: 1, objectKey: `revisions/${randomUUID()}/scene.glb`,
      outputSha256: 'a'.repeat(64), transform: identityTransform }).returning();
    await assert.rejects(approveRevision(db, storage, revisions, owner, failedRevision.id, approvalBody), { status: 409 });
    const incomplete = await ingestLidarFixture(db, source, owner, privateSpace.id);
    await worker().runOnce(incomplete.job.id);
    const incompleteId = (await readJob(db, owner, incomplete.job.id)).revisionId!;
    await rm(path.join(revisions.root, incompleteId, 'preview.jpg'));
    await assert.rejects(approveRevision(db, storage, revisions, owner, incompleteId, { name: 'Incomplete' }), { status: 409 });
    await writeFile(path.join(revisions.root, incompleteId, 'preview.jpg'), await lidarFixtureFile('preview.jpg'));
    await assert.rejects(approveRevision(db, storage, revisions, owner, incompleteId, approvalBody), { status: 400 });
    const privateApproval = await approveRevision(db, storage, revisions, owner, incompleteId, { name: 'Private approved' });
    assert.equal(privateApproval.scan.visibility, 'private');
    await assert.rejects(shareMetadata(db, null, privateApproval.scan.shareId), { status: 404 });
    await assert.rejects(shareScene(db, storage, viewer, privateApproval.scan.shareId), { status: 404 });

    // A revoked revision cannot be exposed by making the viewer record public.
    await db.update(scanRevisions).set({ status: 'rejected', approvedBy: null, approvedAt: null }).where(eq(scanRevisions.id, revisionId));
    assert.equal((await metadataRoute(request(), context)).status, 404);
    await assert.rejects(downloadScan(db, storage, null, scan.id), { status: 404 });
    await db.update(scanRevisions).set({ status: 'approved', approvedBy: owner.id, approvedAt: new Date() }).where(eq(scanRevisions.id, revisionId));

    // Existing manual scans and graph/path records keep their original behavior and IDs.
    const legacy = await createScan(db, storage, owner, space.id, { name: 'Manual upload', visibility: 'public',
      transform: identityTransform }, await lidarFixtureFile('source.glb'), 'manual.glb');
    assert.equal(legacy.sourceRevisionId, null);
    assert.deepEqual(await shareScene(db, storage, null, legacy.shareId), await lidarFixtureFile('source.glb'));
    await assert.rejects(sharePoints(db, revisions, null, legacy.shareId), { status: 404 });
    const [a, b] = await db.insert(navNodes).values([{ spaceId: space.id, x: 0, y: 0, z: 0 }, { spaceId: space.id, x: 1, y: 0, z: 0 }]).returning();
    await db.insert(navEdges).values({ spaceId: space.id, fromNodeId: a.id, toNodeId: b.id, distance: 1 });
    const [saved] = await db.insert(paths).values({ spaceId: space.id, ownerId: owner.id, name: 'Existing route' }).returning();
    await db.insert(pathWaypoints).values([{ pathId: saved.id, spaceId: space.id, nodeId: a.id, sequence: 0 }, { pathId: saved.id, spaceId: space.id, nodeId: b.id, sequence: 1 }]);
    const before = await db.select().from(pathWaypoints).where(eq(pathWaypoints.pathId, saved.id));
    const aligned = await ingestLidarFixture(db, source, owner, space.id); await worker().runOnce(aligned.job.id);
    const alignedId = (await readJob(db, owner, aligned.job.id)).revisionId!;
    await assert.rejects(approveRevision(db, storage, revisions, owner, alignedId, { name: 'Unaligned' }), { status: 409 });
    await approveRevision(db, storage, revisions, owner, alignedId, approvalBody);
    assert.deepEqual(await db.select().from(pathWaypoints).where(eq(pathWaypoints.pathId, saved.id)), before);

    // Filesystem corruption/symlink replacement cannot turn approved keys into arbitrary reads.
    const pointsPath = path.join(revisions.root, revisionId, 'scene.ply');
    await rm(pointsPath); await symlink(path.join(root, 'outside'), pointsPath);
    await assert.rejects(sharePoints(db, revisions, null, scan.shareId), { status: 409 });
    await storage.put(`scans/${scan.id}.glb`, Buffer.from('corrupt'));
    await assert.rejects(shareScene(db, storage, null, scan.shareId), { status: 409 });
  } finally {
    if (spaceIds.length) {
      await db.delete(scans).where(inArray(scans.spaceId, spaceIds));
      await db.delete(scanRevisions).where(inArray(scanRevisions.spaceId, spaceIds));
      const ids = await db.select({ id: captures.id }).from(captures).where(inArray(captures.spaceId, spaceIds));
      if (ids.length) await db.delete(processingJobs).where(inArray(processingJobs.captureId, ids.map(row => row.id)));
      await db.delete(captures).where(inArray(captures.spaceId, spaceIds));
      await db.delete(paths).where(inArray(paths.spaceId, spaceIds));
      await db.delete(navEdges).where(inArray(navEdges.spaceId, spaceIds));
      await db.delete(navNodes).where(inArray(navNodes.spaceId, spaceIds));
      await db.delete(spaces).where(inArray(spaces.id, spaceIds));
    }
    if (ownerId) await db.delete(users).where(eq(users.id, ownerId)); if (viewerId) await db.delete(users).where(eq(users.id, viewerId));
    await client.end(); await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
