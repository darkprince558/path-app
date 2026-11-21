import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { captures, captureFrames, processingJobs, scanRevisions, scans, spaces, users } from '../../db/schema';

test('LiDAR provenance, retries and approval are isolated from existing scans', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 1, prepare: false });
  const db = drizzle(client);
  const rollback = new Error('rollback synthetic schema test');
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const digest = 'a'.repeat(64);
  try {
    await assert.rejects(db.transaction(async tx => {
      // Savepoints let each rejected write leave the surrounding fixture transaction usable.
      const reject = async (write: (nested: typeof tx) => PromiseLike<unknown>, code: string) => {
        await assert.rejects(tx.transaction(async nested => { await write(nested); }), error => {
          const cause = (error as { cause?: { code?: string } }).cause;
          return (cause?.code ?? (error as { code?: string }).code) === code;
        });
      };
      const suffix = randomUUID();
      const [owner, other] = await tx.insert(users).values([
        { auth0Sub: `lidar|${suffix}|owner`, username: `lidar_${suffix}`, displayName: 'Owner' },
        { auth0Sub: `lidar|${suffix}|other`, username: `other_${suffix}`, displayName: 'Other' },
      ]).returning();
      const [space, otherSpace] = await tx.insert(spaces).values([
        { ownerId: owner.id, name: 'LiDAR test space' },
        { ownerId: other.id, name: 'Other space' },
      ]).returning();
      const [legacyScan] = await tx.insert(scans).values({
        ownerId: owner.id, spaceId: space.id, name: 'Existing GLB', objectKey: `legacy/${suffix}.glb`,
        format: 'glb', status: 'ready', transform: matrix,
      }).returning();
      const captureInput = {
        ownerId: owner.id, spaceId: space.id, deviceCaptureId: suffix,
        manifestVersion: 1, manifest: { files: [] }, manifestSha256: digest,
        bundleObjectPrefix: `captures/${suffix}`, device: { model: 'synthetic' },
        coordinateSystem: { units: 'metres', upAxis: 'Y' }, entrancePose: matrix,
      };
      const [capture] = await tx.insert(captures).values(captureInput).returning();
      assert.equal(capture.status, 'uploading');
      assert.deepEqual(capture.device, { model: 'synthetic' });
      assert.deepEqual(capture.manifest, { files: [] });
      await reject(n => n.insert(captures).values({ ...captureInput, bundleObjectPrefix: 'duplicate' }), '23505');
      await reject(n => n.insert(captures).values({ ...captureInput, deviceCaptureId: 'foreign',
        bundleObjectPrefix: 'foreign', spaceId: otherSpace.id }), '23503');
      await reject(n => n.update(captures).set({ status: 'uploaded' }).where(eq(captures.id, capture.id)), '23514');
      await tx.update(captures).set({ status: 'uploaded', uploadedAt: new Date() }).where(eq(captures.id, capture.id));
      const frameInput = { captureId: capture.id, frameId: 'junction-02', objectKey: `frames/${suffix}.jpg`,
        sha256: digest, cameraPose: matrix, width: 640, height: 480 };
      await tx.insert(captureFrames).values(frameInput);
      await reject(n => n.insert(captureFrames).values({ ...frameInput, objectKey: 'duplicate-frame' }), '23505');
      await reject(n => n.insert(captureFrames).values({ ...frameInput, frameId: 'bad-pose',
        objectKey: 'bad-pose', cameraPose: [1, 2] }), '23514');
      await reject(n => n.insert(captureFrames).values({ ...frameInput, frameId: 'bad-hash',
        objectKey: 'bad-hash', sha256: 'invalid' }), '23514');
      const jobInput = { captureId: capture.id, idempotencyKey: 'cpu-v1', inputSha256: digest,
        processorVersion: 'synthetic-v1', configuration: { resolution: 0.1 } };
      const [job] = await tx.insert(processingJobs).values(jobInput).returning();
      assert.equal(job.status, 'queued');
      assert.deepEqual(job.configuration, { resolution: 0.1 });
      await reject(n => n.insert(processingJobs).values(jobInput), '23505');
      await reject(n => n.update(processingJobs).set({ progress: 101 }).where(eq(processingJobs.id, job.id)), '23514');
      await reject(n => n.update(processingJobs).set({ attemptCount: -1 }).where(eq(processingJobs.id, job.id)), '23514');
      await reject(n => n.update(processingJobs).set({ leaseToken: randomUUID() }).where(eq(processingJobs.id, job.id)), '23514');
      const [secondCapture] = await tx.insert(captures).values({ ...captureInput,
        deviceCaptureId: `${suffix}-second`, bundleObjectPrefix: `captures/${suffix}-second` }).returning();
      const revisionInput = { captureId: capture.id, spaceId: space.id, processingJobId: job.id,
        scanId: legacyScan.id, revision: 1, objectKey: `outputs/${suffix}.glb`,
        outputSha256: digest, transform: matrix, metadata: { evidenceFrameIds: ['junction-02'] } };
      const [revision] = await tx.insert(scanRevisions).values(revisionInput).returning();
      assert.equal(revision.status, 'draft');
      await reject(n => n.insert(scanRevisions).values({ ...revisionInput,
        objectKey: 'wrong-job', captureId: secondCapture.id }), '23503');
      await reject(n => n.insert(scanRevisions).values({ ...revisionInput,
        objectKey: 'wrong-space', spaceId: otherSpace.id, revision: 2 }), '23503');
      const [foreignScan] = await tx.insert(scans).values({
        ownerId: other.id, spaceId: otherSpace.id, name: 'Other GLB', objectKey: `other/${suffix}.glb`,
        format: 'glb', status: 'ready', transform: matrix,
      }).returning();
      await reject(n => n.insert(scanRevisions).values({ ...revisionInput,
        objectKey: 'wrong-scan', scanId: foreignScan.id, revision: 2 }), '23503');
      await reject(n => n.update(scanRevisions).set({ status: 'approved' }).where(eq(scanRevisions.id, revision.id)), '23514');
      await reject(n => n.update(scanRevisions).set({ approvedBy: owner.id }).where(eq(scanRevisions.id, revision.id)), '23514');
      await tx.update(scanRevisions).set({ status: 'approved', approvedBy: owner.id, approvedAt: new Date() })
        .where(eq(scanRevisions.id, revision.id));
      // Approval is recorded without publishing over the existing scan or changing its identity.
      const [unchanged] = await tx.select().from(scans).where(eq(scans.id, legacyScan.id));
      assert.deepEqual(unchanged, legacyScan);
      await reject(n => n.delete(captures).where(eq(captures.id, capture.id)), '23503');
      await reject(n => n.delete(scans).where(eq(scans.id, legacyScan.id)), '23503');
      throw rollback;
    }), error => error === rollback);
  } finally {
    await client.end();
  }
});
