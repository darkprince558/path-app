import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { captures, processingJobs, scanRevisions, scans, spaces, users } from '../../db/schema';
import { LocalScanStorage } from '../storage';
import { LocalCaptureStorage } from '../storage/captures';
import { LocalRevisionStorage } from '../storage/revisions';
import { CaptureWorker } from '../processing/worker';
import { MockCaptureProcessor } from '../processing/processor';
import { ingestLidarFixture } from './fixtures/lidar-fixture';
import { approveRevision } from './revision-approval';
import { readJob } from './jobs';
import { cueDraftInput, cuePatch, listRevisionCues, listShareCues, saveCueDrafts, updateCue } from './cues';
import { GET as revisionCuesRoute } from '../../app/api/scan-revisions/[revisionId]/cues/route';
import { PATCH as cueRoute } from '../../app/api/cues/[id]/route';

test('cue review requires sign-in', async () => {
  const id = randomUUID();
  const headers = { Authorization: 'Bearer invalid' };
  const list = await revisionCuesRoute(new Request(`http://localhost/api/scan-revisions/${id}/cues`, { headers }),
    { params: Promise.resolve({ revisionId: id }) });
  const patch = await cueRoute(new Request(`http://localhost/api/cues/${id}`, { method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }) }),
  { params: Promise.resolve({ id }) });
  assert.equal(list.status, 401);
  assert.equal(patch.status, 401);
});

test('cue edits and drafts are validated', () => {
  assert.deepEqual(cuePatch.parse({ instruction: '  Turn left   at the door. ' }), { instruction: 'Turn left at the door.' });
  assert.deepEqual(cuePatch.parse({ status: 'approved' }), { status: 'approved' });
  for (const bad of [{}, { status: 'published' }, { status: 'abstained' }, { instruction: '   ' },
    { instruction: 'x'.repeat(201) }, { instruction: 'bell\u0007' }, { other: 1 }]) {
    assert.equal(cuePatch.safeParse(bad).success, false, JSON.stringify(bad));
  }
  const draft = { routeSegmentId: 'seg-1', sequence: 0, instruction: 'Turn left at the mural.', sourceFrameIds: ['frame-0012'] };
  assert.equal(cueDraftInput.safeParse(draft).success, true);
  assert.equal(cueDraftInput.safeParse({ ...draft, instruction: '', abstained: true }).success, true);
  assert.equal(cueDraftInput.safeParse({ ...draft, instruction: '' }).success, false);
  assert.equal(cueDraftInput.safeParse({ ...draft, sequence: -1 }).success, false);
  assert.equal(cueDraftInput.safeParse({ ...draft, sourceFrameIds: ['../secret'] }).success, false);
});

test('owners review cues; guests read approved cues in route order', { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 }, async () => {
  const previous = { DATABASE_URL: process.env.DATABASE_URL, SCAN_STORAGE_DIR: process.env.SCAN_STORAGE_DIR,
    CAPTURE_STORAGE_DIR: process.env.CAPTURE_STORAGE_DIR, REVISION_STORAGE_DIR: process.env.REVISION_STORAGE_DIR };
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 5, prepare: false }); const db = drizzle(client);
  const root = await mkdtemp(path.join(tmpdir(), 'cues-test-'));
  Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, SCAN_STORAGE_DIR: path.join(root, 'scans'),
    CAPTURE_STORAGE_DIR: path.join(root, 'captures'), REVISION_STORAGE_DIR: path.join(root, 'revisions') });
  const storage = new LocalScanStorage(process.env.SCAN_STORAGE_DIR!);
  const source = new LocalCaptureStorage(process.env.CAPTURE_STORAGE_DIR!);
  const revisions = new LocalRevisionStorage(process.env.REVISION_STORAGE_DIR!);
  const worker = new CaptureWorker({ databaseUrl: process.env.TEST_DATABASE_URL!, captures: source, revisions,
    processor: new MockCaptureProcessor() });
  const userIds: string[] = [];
  const spaceIds: string[] = [];
  try {
    const suffix = randomUUID();
    const [owner, guest] = await db.insert(users).values([
      { auth0Sub: `cues|${suffix}`, username: `cues_${suffix}`, displayName: 'Owner' },
      { auth0Sub: `cues-guest|${suffix}`, username: `cues_guest_${suffix}`, displayName: 'Guest' },
    ]).returning(); userIds.push(owner.id, guest.id);
    const [space] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Cue fixture', visibility: 'public',
      boundary: { coordinateSystem: { units: 'metres', upAxis: 'Y', calibrated: true } } }).returning();
    spaceIds.push(space.id);
    const queued = await ingestLidarFixture(db, source, owner, space.id);
    await worker.runOnce(queued.job.id);
    const revisionId = (await readJob(db, owner, queued.job.id)).revisionId!;
    const { scan } = await approveRevision(db, storage, revisions, owner, revisionId, { name: 'Cue hall', visibility: 'public' });

    // Gemini's drafts arrive out of order; one turn had no clear landmark.
    await saveCueDrafts(db, revisionId, [
      { routeSegmentId: 'seg-c', sequence: 2, landmark: 'stair C4', instruction: 'Take the stairs up at C4.', confidence: 'medium', sourceFrameIds: ['frame-0007'] },
      { routeSegmentId: 'seg-a', sequence: 0, landmark: 'purple mural', instruction: 'Turn left at the purple mural.', confidence: 'high', sourceFrameIds: ['frame-0000'], model: 'gemini-3.6-flash', promptVersion: 'landmark-v2' },
      { routeSegmentId: 'seg-b', sequence: 1, instruction: '', abstained: true },
    ]);
    const review = await listRevisionCues(db, owner, revisionId);
    assert.deepEqual(review.map(cue => cue.routeSegmentId), ['seg-a', 'seg-b', 'seg-c']);
    assert.deepEqual(review.map(cue => cue.status), ['draft', 'abstained', 'draft']);
    assert.deepEqual(review[0].sourceFrameIds, ['frame-0000']);
    await assert.rejects(listRevisionCues(db, guest, revisionId), { status: 404 });
    assert.deepEqual(await listShareCues(db, null, scan.shareId), []);

    const [a, b, c] = review;
    await assert.rejects(updateCue(db, guest, a.id, { status: 'approved' }), { status: 404 });
    await assert.rejects(updateCue(db, owner, b.id, { status: 'approved' }), { status: 400 }); // nothing to approve yet
    assert.equal((await updateCue(db, owner, b.id, { status: 'rejected' })).status, 'rejected');
    const edited = await updateCue(db, owner, a.id, { instruction: 'Turn left at the purple mural by the doors.', status: 'approved' });
    assert.equal(edited.status, 'approved');
    await updateCue(db, owner, c.id, { status: 'approved' });

    const forGuest = await listShareCues(db, null, scan.shareId);
    assert.deepEqual(forGuest.map(cue => cue.instruction), ['Turn left at the purple mural by the doors.', 'Take the stairs up at C4.']);
    assert.deepEqual(forGuest.map(cue => cue.sourceFrameIds), [[], []]);
    assert.deepEqual((await listShareCues(db, owner, scan.shareId))[0].sourceFrameIds, ['frame-0000']);

    // A newer Gemini run replaces drafts but never the owner's decisions.
    await saveCueDrafts(db, revisionId, [
      { routeSegmentId: 'seg-a', sequence: 0, instruction: 'Gemini rewrote this.', sourceFrameIds: [] },
      { routeSegmentId: 'seg-d', sequence: 3, instruction: 'Arrive at the booth.', sourceFrameIds: [] },
    ]);
    const after = await listRevisionCues(db, owner, revisionId);
    assert.equal(after.find(cue => cue.routeSegmentId === 'seg-a')?.instruction, 'Turn left at the purple mural by the doors.');
    assert.deepEqual(after.map(cue => cue.routeSegmentId), ['seg-a', 'seg-b', 'seg-c', 'seg-d']);

    // Back to review hides it from guests again.
    await updateCue(db, owner, c.id, { status: 'draft' });
    assert.equal((await listShareCues(db, null, scan.shareId)).length, 1);
  } finally {
    if (spaceIds.length) {
      await db.delete(scans).where(inArray(scans.spaceId, spaceIds));
      await db.delete(scanRevisions).where(inArray(scanRevisions.spaceId, spaceIds)); // cascades to landmark_cues
      const ids = await db.select({ id: captures.id }).from(captures).where(inArray(captures.spaceId, spaceIds));
      if (ids.length) await db.delete(processingJobs).where(inArray(processingJobs.captureId, ids.map(row => row.id)));
      await db.delete(captures).where(inArray(captures.spaceId, spaceIds));
      await db.delete(spaces).where(inArray(spaces.id, spaceIds));
    }
    for (const id of userIds) await db.delete(users).where(eq(users.id, id)).catch(() => {});
    await client.end(); await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
