import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { connectDatabase } from '../../db/client';
import { captureFrames, captures, landmarkCues, paths, scanRevisions, scans, spaces } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import { captureManifest, type CaptureManifest } from '../capture/contract';
import { captureObjectKey, type CaptureStorage } from '../storage/captures';
import { GeminiServiceError, type FrameSelection, type LandmarkRequest, type LandmarkResult } from '../gemini/client';
import { pathTurns, PathError, type Turn } from '../gemini/turns';
import { digestBytes } from './captures';
import { cueDraftInput, listRevisionCues, saveCueDrafts } from './cues';
import { ApiError, conflict, notFound } from './http';
import { pathResponse } from './paths';
import { uuid } from './validation';

/*
 * POST /api/scan-revisions/:revisionId/cues/generate  (owner only)
 *
 * The owner's "Generate directions" button. For every saved path in the revision's space:
 *   pathTurns (left/right/stairs from the path's points)
 *   -> pick photos near each turn (Gemini service /v1/frames/select, using the scan's camera poses)
 *   -> Gemini landmark drafts (/v1/landmarks)
 *   -> saveCueDrafts (one cue per turn; the same turn on several paths is one cue)
 *
 * Gemini takes about 10-60 s per turn, so one request handles at most MAX_TURNS_PER_REQUEST
 * turns and reports `remaining`; pressing the button again continues. Turns that already have
 * a cue are skipped unless `regenerate` is true, and approved/rejected cues are never replaced.
 */

type Db = ReturnType<typeof connectDatabase>['db'];

export const MAX_TURNS_PER_REQUEST = 12;
const HEADING_BUCKET_DEG = 15;

export const generateCuesInput = z.object({
  regenerate: z.boolean().default(false),
}).strict();

/** What this module needs from the Gemini service (the real client or a test fake). */
export interface GeminiService {
  selectFrames(turn: Pick<Turn, 'position' | 'incomingHeading' | 'outgoingHeading' | 'maneuver'>,
    frames: unknown[], captureToSpace?: number[]): Promise<FrameSelection>;
  proposeLandmarks(request: LandmarkRequest): Promise<LandmarkResult>;
}

export type TurnOutcome = 'generated' | 'abstained' | 'skipped' | 'no_photos' | 'failed';

export interface RouteTurn {
  key: string; // routeSegmentId: stable for the same turn on any path
  sequence: number;
  turn: Turn;
}

const round = (value: number, places = 1) => {
  const f = 10 ** places;
  return (Math.round(value * f) / f + 0).toFixed(places);
};

function headingBucket(turn: Turn) {
  const deg = (Math.atan2(turn.incomingHeading.x, -turn.incomingHeading.z) * 180) / Math.PI;
  return ((Math.round(deg / HEADING_BUCKET_DEG) * HEADING_BUCKET_DEG) % 360 + 360) % 360;
}

/**
 * A stable ID for "this turn, approached from this direction". Two saved paths that pass the
 * same junction the same way produce the same key, so they share one cue. The opposite
 * direction (or a different turn at the same spot) gets its own key.
 */
export function turnKey(turn: Turn) {
  const p = turn.position;
  const parts = ['turn', round(p.x), round(p.y), round(p.z), `h${headingBucket(turn)}`, turn.maneuver];
  if (turn.side) parts.push(turn.side);
  return parts.join(':');
}

/** Every announced turn across the saved paths, de-duplicated, in first-seen order. */
export function collectRouteTurns(routes: { points: { x: number; y: number; z: number }[] }[]): RouteTurn[] {
  const seen = new Map<string, RouteTurn>();
  for (const route of routes) {
    if (route.points.length < 2) continue;
    let turns: Turn[];
    try { turns = pathTurns(route.points); } catch (error) { if (error instanceof PathError) continue; throw error; }
    for (const turn of turns) {
      if (turn.maneuver === 'arrive' || turn.maneuver === 'straight') continue;
      const key = turnKey(turn);
      if (!seen.has(key)) seen.set(key, { key, sequence: seen.size, turn });
    }
  }
  return [...seen.values()];
}

const CONFIDENCE = { clear: 'high', partial: 'medium', uncertain: 'low' } as const;

/**
 * One cue draft for saveCueDrafts: Gemini's best candidate, or an abstention.
 * Turn geometry (maneuver, side, position, incomingHeading) is included only for the fields
 * cueDraftInput accepts, so this works before and after the landmark_cues geometry columns land.
 */
export function toCueDraft(route: RouteTurn, result: LandmarkResult) {
  const best = result.candidates[0];
  const draft: Record<string, unknown> = best && !result.abstained ? {
    routeSegmentId: route.key, sequence: route.sequence, landmark: best.landmark, instruction: best.instruction,
    confidence: CONFIDENCE[best.visibility] ?? null, abstained: false, sourceFrameIds: best.sourceFrameIds,
    model: result.model, promptVersion: result.promptVersion,
  } : {
    routeSegmentId: route.key, sequence: route.sequence, landmark: null, instruction: '', confidence: null,
    abstained: true, sourceFrameIds: [], model: result.model, promptVersion: result.promptVersion,
  };
  const geometry: Record<string, unknown> = {
    maneuver: route.turn.maneuver, side: route.turn.side, position: route.turn.position,
    incomingHeading: route.turn.incomingHeading,
  };
  const accepted = new Set(Object.keys(cueDraftInput.shape));
  for (const [key, value] of Object.entries(geometry)) if (accepted.has(key)) draft[key] = value;
  return draft;
}

/** Same rule as cue review and revision approval: the user owns both the capture and the space. */
async function ownedRevision(db: Db, user: AppUser, revisionId: string) {
  const [row] = await db.select({ revision: scanRevisions, capture: captures, spaceOwner: spaces.ownerId })
    .from(scanRevisions).innerJoin(captures, eq(captures.id, scanRevisions.captureId))
    .innerJoin(spaces, eq(spaces.id, scanRevisions.spaceId))
    .where(eq(scanRevisions.id, uuid.parse(revisionId))).limit(1);
  if (!row || row.capture.ownerId !== user.id || row.spaceOwner !== user.id) throw notFound();
  if (row.revision.status === 'rejected' || row.revision.status === 'superseded') {
    throw conflict('This scan revision is no longer in use');
  }
  return row;
}

/** Reads one capture photo and checks it against the manifest, like the owner-only frame route. */
async function readFrame(storage: CaptureStorage, captureId: string, manifest: CaptureManifest, frameId: string) {
  const relative = `frames/${frameId}.jpg`;
  const expected = manifest.files.find(file => file.path === relative);
  if (!expected) throw new Error('frame missing from manifest');
  const bytes = await storage.read(captureObjectKey(captureId, relative), expected.byteSize);
  const actual = digestBytes(bytes);
  if (actual.byteSize !== expected.byteSize || actual.sha256 !== expected.sha256) throw new Error('frame digest mismatch');
  return bytes;
}

export async function generateRevisionCues(db: Db, user: AppUser, revisionId: string,
  input: z.infer<typeof generateCuesInput>, deps: { gemini: GeminiService; storage: CaptureStorage }) {
  const { revision, capture } = await ownedRevision(db, user, revisionId);

  // The owner's saved routes in this space, as points in space coordinates.
  const saved = await db.select().from(paths)
    .where(and(eq(paths.spaceId, revision.spaceId), eq(paths.ownerId, user.id)))
    .orderBy(asc(paths.createdAt), asc(paths.id));
  if (!saved.length) throw new ApiError(409, 'NO_SAVED_ROUTES', 'Save at least one route in this space first');
  const routes = await Promise.all(saved.map(async path => ({
    points: (await pathResponse(db, path)).waypoints.map(w => ({ x: w.x, y: w.y, z: w.z })),
  })));
  const turns = collectRouteTurns(routes);

  const frameRows = await db.select().from(captureFrames).where(eq(captureFrames.captureId, capture.id));
  if (!frameRows.length) throw new ApiError(409, 'NO_PHOTOS', 'This scan has no camera photos');
  const frames = frameRows.map(f => ({ id: f.frameId, cameraPose: f.cameraPose, timestampSeconds: f.timestampSeconds }));
  const manifest = captureManifest.parse(capture.manifest);
  // Camera poses share the GLB's frame; the scan's transform places both in the space.
  const [scan] = await db.select({ transform: scans.transform }).from(scans).where(eq(scans.sourceRevisionId, revision.id)).limit(1);
  const captureToSpace = scan?.transform ?? revision.transform;

  const existing = new Map((await db.select({ segment: landmarkCues.routeSegmentId, status: landmarkCues.status })
    .from(landmarkCues).where(eq(landmarkCues.revisionId, revision.id))).map(row => [row.segment, row.status]));

  const results: { routeSegmentId: string; sequence: number; maneuver: string; outcome: TurnOutcome; code?: string }[] = [];
  let processed = 0;
  let stoppedEarly = false;
  for (const route of turns) {
    const report = (outcome: TurnOutcome, code?: string) =>
      results.push({ routeSegmentId: route.key, sequence: route.sequence, maneuver: route.turn.maneuver, outcome, ...(code ? { code } : {}) });
    const status = existing.get(route.key);
    if (status === 'approved' || status === 'rejected' || (status && !input.regenerate)) { report('skipped'); continue; }
    if (processed >= MAX_TURNS_PER_REQUEST || stoppedEarly) continue; // counted in `remaining`
    processed += 1;
    try {
      const pick = await deps.gemini.selectFrames(route.turn, frames, captureToSpace);
      if (!pick.usable) { report('no_photos'); continue; }
      const roles = (['approach', 'junction', 'exit'] as const).filter(role => pick[role]);
      const photos = await Promise.all(roles.map(async role => ({
        frameId: pick[role]!, role, mimeType: 'image/jpeg' as const,
        image: await readFrame(deps.storage, capture.id, manifest, pick[role]!),
      })));
      const result = await deps.gemini.proposeLandmarks({
        requestId: randomUUID(), scanRevisionId: revision.id, routeSegmentId: route.key,
        approachDirectionId: `h${headingBucket(route.turn)}`,
        verifiedMovement: { maneuver: route.turn.maneuver as Exclude<Turn['maneuver'], 'straight' | 'arrive'>,
          ...(route.turn.side ? { side: route.turn.side } : {}) },
        frames: photos,
      });
      await saveCueDrafts(db, revision.id, [toCueDraft(route, result)]); // save as we go: each call costs time
      report(result.abstained ? 'abstained' : 'generated');
    } catch (error) {
      if (error instanceof GeminiServiceError) {
        report('failed', error.code);
        if (error.retryable || error.status === 401) stoppedEarly = true; // busy or misconfigured: stop, retry later
        continue;
      }
      report('failed', 'PHOTO_UNREADABLE');
      if (!(error instanceof Error && /frame|digest|ENOENT|manifest/i.test(error.message))) {
        console.error('Cue generation failed for one turn', error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }

  const count = (outcome: TurnOutcome) => results.filter(r => r.outcome === outcome).length;
  return {
    cues: await listRevisionCues(db, user, revision.id),
    summary: {
      turns: turns.length, generated: count('generated'), abstained: count('abstained'), skipped: count('skipped'),
      noPhotos: count('no_photos'), failed: count('failed'), remaining: turns.length - results.length,
    },
    turns: results,
  };
}
