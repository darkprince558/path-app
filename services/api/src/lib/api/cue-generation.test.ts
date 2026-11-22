import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { captures, navEdges, navNodes, paths, pathWaypoints, processingJobs, scanRevisions, scans, spaces, users } from '../../db/schema';
import { GeminiServiceError, type LandmarkRequest, type LandmarkResult } from '../gemini/client';
import { pathTurns } from '../gemini/turns';
import { LocalCaptureStorage } from '../storage/captures';
import { ingestLidarFixture } from './fixtures/lidar-fixture';
import { collectRouteTurns, generateRevisionCues, toCueDraft, turnKey, type GeminiService } from './cue-generation';
import { cueDraftInput, listShareCues, updateCue } from './cues';
import { POST as generateRoute } from '../../app/api/scan-revisions/[revisionId]/cues/generate/route';

const P = (x: number, y: number, z: number) => ({ x, y, z });
const toBooth = [P(0, 0, 0), P(0, 0, -4), P(3, 0, -4)];
const toWorkshop = [P(0, 0, 0), P(0, 0, -4), P(-3, 0, -4)];

function result(overrides: Partial<LandmarkResult> = {}): LandmarkResult {
  return {
    requestId: 'r', category: 'CANDIDATES', abstained: false, abstentionReason: null, requiresReview: true,
    maneuver: 'left', side: null, frameIds: ['junction-02'], model: 'gemini-3.6-flash', promptVersion: 'landmark-v2',
    elapsedMs: 10, attempts: 1, fingerprint: 'sha256:x', rawResponseText: null,
    candidates: [
      { landmark: 'purple mural', landmarkType: 'artwork', visibleText: null, sourceFrameIds: ['junction-02'],
        instruction: 'Turn left at the purple mural.', visibility: 'clear', reason: null },
      { landmark: 'bench', landmarkType: 'furniture', visibleText: null, sourceFrameIds: ['junction-02'],
        instruction: 'Turn left after the bench.', visibility: 'partial', reason: null },
    ],
    ...overrides,
  };
}

test('turn keys: one cue per turn and direction, shared across saved paths', () => {
  const turns = collectRouteTurns([{ points: toWorkshop }, { points: toBooth }, { points: toWorkshop }, { points: [P(0, 0, 0)] }]);
  assert.deepEqual(turns.map(t => [t.turn.maneuver, t.sequence]), [['left', 0], ['right', 1]]);
  assert.equal(turns[0].key, 'turn:0.0:0.0:-4.0:h0:left');
  // Walking back from the workshop reaches the same junction from the other direction: a different cue.
  const back = collectRouteTurns([{ points: [P(-3, 0, -4), P(0, 0, -4), P(0, 0, 0)] }]);
  assert.equal(back[0].turn.maneuver, 'right');
  assert.notEqual(back[0].key, turns[0].key);
  assert.match(back[0].key, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/); // the Gemini service's ID rule
  // Stairs keep their side in the key.
  assert.equal(turnKey(pathTurns([[0, 0, 0], [0, 0, -8], [-3, -1.8, -8]])[0]!), 'turn:0.0:0.0:-8.0:h0:stairs_down:left');
});

test('arrival and straight stretches are not turned into cues', () => {
  assert.deepEqual(collectRouteTurns([{ points: [P(0, 0, 0), P(0, 0, -4), P(0.2, 0, -8)] }]), []);
});

test('the best candidate becomes the draft, with visibility as confidence', () => {
  const route = collectRouteTurns([{ points: toWorkshop }])[0];
  const draft = toCueDraft(route, result());
  assert.equal(draft.instruction, 'Turn left at the purple mural.');
  assert.equal(draft.confidence, 'high');
  assert.equal(draft.landmark, 'purple mural');
  assert.deepEqual(draft.sourceFrameIds, ['junction-02']);
  assert.ok(cueDraftInput.safeParse(draft).success, 'draft must satisfy saveCueDrafts');
  const unsure = toCueDraft(route, result({ candidates: [{ ...result().candidates[1], visibility: 'uncertain' }] }));
  assert.equal(unsure.confidence, 'low');
});

test('an abstention becomes an abstained draft with no text', () => {
  const route = collectRouteTurns([{ points: toWorkshop }])[0];
  const draft = toCueDraft(route, result({ abstained: true, category: 'NO_CLEAR_LANDMARK', candidates: [] }));
  assert.equal(draft.abstained, true);
  assert.equal(draft.instruction, '');
  assert.ok(cueDraftInput.safeParse(draft).success);
});

test('turn geometry is only sent when saveCueDrafts accepts it', () => {
  const route = collectRouteTurns([{ points: toWorkshop }])[0];
  const draft = toCueDraft(route, result());
  const accepted = new Set(Object.keys(cueDraftInput.shape));
  for (const key of Object.keys(draft)) assert.ok(accepted.has(key), `unexpected field ${key}`);
});

test('generating directions requires sign-in', async () => {
  const id = randomUUID();
  const response = await generateRoute(new Request(`http://localhost/api/scan-revisions/${id}/cues/generate`,
    { method: 'POST', headers: { Authorization: 'Bearer invalid' } }), { params: Promise.resolve({ revisionId: id }) });
  assert.equal(response.status, 401);
});

/** Fake Gemini service: records requests and returns scripted answers. */
function fakeGemini(script: (request: LandmarkRequest) => LandmarkResult | Error, usable = true) {
  const requests: LandmarkRequest[] = [];
  const selections: unknown[] = [];
  const service: GeminiService = {
    async selectFrames(turn, frames, captureToSpace) {
      selections.push({ turn, frames, captureToSpace });
      return { approach: null, junction: usable ? 'junction-02' : null, exit: null, usable, scores: {}, consideredFrames: frames.length };
    },
    async proposeLandmarks(request) {
      requests.push(request);
      const answer = script(request);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { service, requests, selections };
}

test('owner generates directions from saved paths; reruns keep decisions', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async () => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 5, prepare: false }); const db = drizzle(client);
  const root = await mkdtemp(path.join(tmpdir(), 'cue-gen-test-'));
  const source = new LocalCaptureStorage(path.join(root, 'captures'));
  const userIds: string[] = [];
  const spaceIds: string[] = [];
  try {
    const suffix = randomUUID();
    const [owner, other] = await db.insert(users).values([
      { auth0Sub: `cuegen|${suffix}`, username: `cuegen_${suffix}`, displayName: 'Owner' },
      { auth0Sub: `cuegen-other|${suffix}`, username: `cuegen_other_${suffix}`, displayName: 'Other' },
    ]).returning(); userIds.push(owner.id, other.id);
    const [space] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Cue generation fixture', visibility: 'public',
      boundary: { coordinateSystem: { units: 'metres', upAxis: 'Y', calibrated: true } } }).returning();
    spaceIds.push(space.id);
    // Real upload: the fixture's photo and pose go into capture storage and capture_frames.
    const queued = await ingestLidarFixture(db, source, owner, space.id);
    // The processing worker can't publish on Windows (directory fsync), so create the revision and
    // its approved scan rows directly. Cue generation only reads them.
    const [job] = await db.update(processingJobs).set({ status: 'succeeded', stage: 'complete', progress: 100, completedAt: new Date() })
      .where(eq(processingJobs.id, queued.job.id)).returning();
    const [revision] = await db.insert(scanRevisions).values({
      captureId: job.captureId, spaceId: space.id, processingJobId: job.id, revision: 1,
      objectKey: `revisions/${randomUUID()}/scene.glb`, outputSha256: '0'.repeat(64),
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      status: 'approved', approvedBy: owner.id, approvedAt: new Date(),
    }).returning();
    const revisionId = revision.id;
    const placed = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, -2, 1]; // scan.transform: capture -> space
    const [scan] = await db.insert(scans).values({ spaceId: space.id, ownerId: owner.id, name: 'Cue hall',
      objectKey: `scans/${randomUUID()}.glb`, format: 'glb', status: 'ready', transform: placed, visibility: 'public',
      sourceRevisionId: revisionId }).returning();

    let gemini = fakeGemini(() => result());
    const deps = () => ({ gemini: gemini.service, storage: source });
    await assert.rejects(generateRevisionCues(db, owner, revisionId, { regenerate: false }, deps()), { status: 409, code: 'NO_SAVED_ROUTES' });

    // The venue fixture: entrance -> junction, then left to the workshop or right to the booth.
    const [entrance, junction, workshop, booth] = await db.insert(navNodes).values(
      [P(0, 0, 0), P(0, 0, -4), P(-3, 0, -4), P(3, 0, -4)].map(p => ({ spaceId: space.id, ...p }))).returning();
    const edges: [typeof entrance, typeof entrance, number][] = [[entrance, junction, 4], [junction, workshop, 3], [junction, booth, 3]];
    await db.insert(navEdges).values(edges.map(([a, b, distance]) => ({ spaceId: space.id, fromNodeId: a.id, toNodeId: b.id, distance })));
    for (const [name, nodes] of [['To workshop', [entrance, junction, workshop]], ['To booth', [entrance, junction, booth]],
      ['Workshop again', [entrance, junction, workshop]]] as const) {
      const [saved] = await db.insert(paths).values({ ownerId: owner.id, spaceId: space.id, name }).returning();
      await db.insert(pathWaypoints).values(nodes.map((node, sequence) => ({ pathId: saved.id, spaceId: space.id, nodeId: node.id, sequence })));
    }

    await assert.rejects(generateRevisionCues(db, other, revisionId, { regenerate: false }, deps()), { status: 404 });

    const first = await generateRevisionCues(db, owner, revisionId, { regenerate: false }, deps());
    assert.deepEqual(first.summary, { turns: 2, generated: 2, abstained: 0, skipped: 0, noPhotos: 0, failed: 0, remaining: 0 });
    assert.deepEqual(gemini.requests.map(r => r.verifiedMovement.maneuver), ['left', 'right']);
    assert.equal(gemini.requests[0].scanRevisionId, revisionId);
    assert.equal(gemini.requests[0].frames[0].frameId, 'junction-02');
    assert.ok(gemini.requests[0].frames[0].image.byteLength > 0, 'real photo bytes read from capture storage');
    assert.deepEqual((gemini.selections[0] as { captureToSpace: number[] }).captureToSpace, scan.transform);
    assert.deepEqual(first.cues.map(c => [c.sequence, c.status, c.instruction, c.confidence]),
      [[0, 'draft', 'Turn left at the purple mural.', 'high'], [1, 'draft', 'Turn left at the purple mural.', 'high']]);

    // Approve the first cue, then generate again: nothing is re-sent unless regenerate is asked for.
    await updateCue(db, owner, first.cues[0].id, { instruction: 'Turn left at the purple mural by the doors.', status: 'approved' });
    gemini = fakeGemini(() => result({ candidates: [{ ...result().candidates[0], instruction: 'Turn right at the new sign.' }] }));
    const again = await generateRevisionCues(db, owner, revisionId, { regenerate: false }, deps());
    assert.equal(again.summary.skipped, 2);
    assert.equal(gemini.requests.length, 0);
    const forced = await generateRevisionCues(db, owner, revisionId, { regenerate: true }, deps());
    assert.equal(forced.summary.generated, 1); // the approved turn is never re-sent
    assert.deepEqual(forced.cues.map(c => c.instruction), ['Turn left at the purple mural by the doors.', 'Turn right at the new sign.']);
    assert.deepEqual((await listShareCues(db, null, scan.shareId)).map(c => c.instruction), ['Turn left at the purple mural by the doors.']);

    // Busy service: report it, stop early, keep earlier cues.
    gemini = fakeGemini(() => new GeminiServiceError(503, 'GEMINI_RATE_LIMITED', 'busy'));
    const busy = await generateRevisionCues(db, owner, revisionId, { regenerate: true }, deps());
    assert.equal(busy.summary.failed, 1);
    assert.equal(busy.turns.find(t => t.outcome === 'failed')?.code, 'GEMINI_RATE_LIMITED');
    assert.equal(busy.cues.length, 2);

    // No photo near a turn: reported, nothing sent to Gemini.
    gemini = fakeGemini(() => result(), false);
    const noPhotos = await generateRevisionCues(db, owner, revisionId, { regenerate: true }, deps());
    assert.equal(noPhotos.summary.noPhotos, 1);
    assert.equal(gemini.requests.length, 0);
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
    for (const id of userIds) await db.delete(users).where(eq(users.id, id)).catch(() => {});
    await client.end(); await rm(root, { recursive: true, force: true });
  }
});
