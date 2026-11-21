import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { destinations, navEdges, navNodes, paths, pathWaypoints, spaces, users } from '../src/db/schema';
import { LocalScanStorage } from '../src/lib/storage';
import { LocalCaptureStorage } from '../src/lib/storage/captures';
import { LocalRevisionStorage } from '../src/lib/storage/revisions';
import { MockCaptureProcessor } from '../src/lib/processing/processor';
import { CaptureWorker } from '../src/lib/processing/worker';
import { ingestLidarFixture, lidarFixtureFile } from '../src/lib/api/fixtures/lidar-fixture';
import { approveRevision } from '../src/lib/api/revision-approval';
import { readJob } from '../src/lib/api/jobs';
import { createScan } from '../src/lib/api/scans';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must identify a migrated disposable local database');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !/(test|stage1)/i.test(target.pathname)) {
  throw new Error('Only disposable localhost test/stage1 databases are allowed');
}
const client = postgres(url, { max: 5, prepare: false }); const db = drizzle(client);
const root = await mkdtemp(path.join(tmpdir(), 'lidar-publishing-demo-'));
const scanRoot = path.join(root, 'scans'), captureRoot = path.join(root, 'captures'), revisionRoot = path.join(root, 'revisions');
const storage = new LocalScanStorage(scanRoot), captureStorage = new LocalCaptureStorage(captureRoot), revisions = new LocalRevisionStorage(revisionRoot);
const worker = new CaptureWorker({ databaseUrl: url, captures: captureStorage, revisions, processor: new MockCaptureProcessor() });
const coordinates = { units: 'metres' as const, upAxis: 'Y' as const, calibrated: true };
const transform = [2,0,0,0, 0,2,0,0, 0,0,2,0, 3,0,-2,1];
try {
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({ auth0Sub: `synthetic-publishing|${suffix}`, username: `synthetic_${suffix}`, displayName: 'Synthetic publishing fixture' }).returning();
  const [space, privateSpace] = await db.insert(spaces).values([
    { ownerId: owner.id, name: 'Approved LiDAR synthetic demo', visibility: 'public', boundary: { coordinateSystem: coordinates } },
    { ownerId: owner.id, name: 'Private approved LiDAR demo', visibility: 'private', boundary: { coordinateSystem: coordinates } },
  ]).returning();
  const processed = await ingestLidarFixture(db, captureStorage, owner, space.id);
  const processedPrivate = await ingestLidarFixture(db, captureStorage, owner, privateSpace.id);
  for (const queued of [processed, processedPrivate]) {
    const result = await worker.runOnce(queued.job.id);
    if (result.state !== 'processed' || result.status !== 'succeeded') throw new Error('Fixture processing did not succeed; stop other local workers and retry');
  }
  const [a, b] = await db.insert(navNodes).values([
    { spaceId: space.id, x: 3, y: 0, z: -2 }, { spaceId: space.id, x: 4, y: 0, z: -2 },
  ]).returning();
  await db.insert(navEdges).values({ spaceId: space.id, fromNodeId: a.id, toNodeId: b.id, distance: 1, bidirectional: false });
  await db.insert(destinations).values({ spaceId: space.id, nodeId: b.id, name: 'Synthetic destination' });
  const [saved] = await db.insert(paths).values({ spaceId: space.id, ownerId: owner.id, name: 'Preserved route', visibility: 'public' }).returning();
  await db.insert(pathWaypoints).values([{ pathId: saved.id, spaceId: space.id, nodeId: a.id, sequence: 0 }, { pathId: saved.id, spaceId: space.id, nodeId: b.id, sequence: 1 }]);
  const job = await readJob(db, owner, processed.job.id), privateJob = await readJob(db, owner, processedPrivate.job.id);
  const approved = await approveRevision(db, storage, revisions, owner, job.revisionId!, { name: 'Approved processed scene',
    visibility: 'public', transform, coordinateSystem: coordinates, alignmentVerified: true });
  const privateApproved = await approveRevision(db, storage, revisions, owner, privateJob.revisionId!, { name: 'Private processed scene' });
  const manual = await createScan(db, storage, owner, space.id, { name: 'Existing manual GLB', visibility: 'public',
    transform, metadata: { coordinateSystem: coordinates, alignmentVerified: true } }, await lidarFixtureFile('source.glb'), 'manual.glb');
  const report = { synthetic: true, root, scanRoot, captureRoot, revisionRoot, spaceId: space.id,
    scanId: approved.scan.id, revisionId: job.revisionId, sharePath: approved.sharePath,
    privateSharePath: privateApproved.sharePath, manualSharePath: `/s/${manual.shareId}`, savedPathId: saved.id,
    startNodeId: a.id, endNodeId: b.id };
  const reportPath = path.join(root, 'report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
} finally { await client.end(); }
