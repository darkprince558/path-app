import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { connectDatabase } from '../../db/client';
import { captures, landmarkCues, scanRevisions, spaces } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import { badRequest, notFound } from './http';
import { readShare } from './shares';
import { uuid } from './validation';

/*
 * Landmark cues ("Turn left at the purple mural."). Gemini drafts one per turn of a scan
 * revision (services/gemini/INTEGRATION.md); the map owner edits, approves or rejects it;
 * guests see approved cues only, in route order (`sequence`).
 *
 *   GET   /api/scan-revisions/:revisionId/cues  owner of the revision: every cue
 *   PATCH /api/cues/:id  {instruction?, status?}  owner: edit, approve, reject, back to draft
 *   GET   /api/shares/:shareId/cues  anyone who may open the share: approved cues only
 *
 * Cues belong to one immutable revision, so a new scan revision never reuses old decisions.
 */

type Db = ReturnType<typeof connectDatabase>['db'];
type CueRow = typeof landmarkCues.$inferSelect;

export const MAX_INSTRUCTION_LENGTH = 200;
const FRAME_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Collapses whitespace; rejects control characters and text over 200 characters. */
const instructionText = z.string().transform(value => value.split(/\s+/).filter(Boolean).join(' '))
  .pipe(z.string().max(MAX_INSTRUCTION_LENGTH).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'No control characters'));

export const cuePatch = z.object({
  instruction: instructionText.pipe(z.string().min(1)).optional(),
  status: z.enum(['draft', 'approved', 'rejected']).optional(),
}).strict().refine(value => value.instruction !== undefined || value.status !== undefined, 'Send instruction or status');

/** One Gemini result for one turn, as the backend's Gemini step saves it. */
export const cueDraftInput = z.object({
  routeSegmentId: z.string().trim().min(1).max(200),
  sequence: z.number().int().min(0),
  landmark: z.string().trim().max(200).nullable().optional(),
  instruction: instructionText,
  confidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
  abstained: z.boolean().default(false),
  sourceFrameIds: z.array(z.string().regex(FRAME_ID)).max(10).default([]),
  model: z.string().trim().max(200).nullable().optional(),
  promptVersion: z.string().trim().max(100).nullable().optional(),
}).strict().refine(value => value.abstained || value.instruction.length > 0, 'A draft needs an instruction unless Gemini abstained');

/** The website's shape (apps/web/src/lib/cues.ts). Guests don't get source frame IDs. */
export function cueResponse(cue: CueRow, includeFrames: boolean) {
  return { id: cue.id, routeSegmentId: cue.routeSegmentId, sequence: cue.sequence, landmark: cue.landmark,
    instruction: cue.instruction, confidence: cue.confidence, status: cue.status,
    sourceFrameIds: includeFrames ? cue.sourceFrameIds : [] };
}

/** The revision, if this user owns both its capture and its space (the approval rule); else 404. */
async function ownedRevision(db: Db, user: AppUser, revisionId: string) {
  const [row] = await db.select({ revision: scanRevisions, captureOwner: captures.ownerId, spaceOwner: spaces.ownerId })
    .from(scanRevisions).innerJoin(captures, eq(captures.id, scanRevisions.captureId))
    .innerJoin(spaces, eq(spaces.id, scanRevisions.spaceId))
    .where(eq(scanRevisions.id, uuid.parse(revisionId))).limit(1);
  if (!row || row.captureOwner !== user.id || row.spaceOwner !== user.id) throw notFound();
  return row.revision;
}

const inRouteOrder = [asc(landmarkCues.sequence), asc(landmarkCues.routeSegmentId)];

export async function listRevisionCues(db: Db, user: AppUser, revisionId: string) {
  const revision = await ownedRevision(db, user, revisionId);
  const rows = await db.select().from(landmarkCues).where(eq(landmarkCues.revisionId, revision.id)).orderBy(...inRouteOrder);
  return rows.map(row => cueResponse(row, true));
}

export async function updateCue(db: Db, user: AppUser, cueId: string, input: z.infer<typeof cuePatch>) {
  const [cue] = await db.select().from(landmarkCues).where(eq(landmarkCues.id, uuid.parse(cueId))).limit(1);
  if (!cue) throw notFound();
  await ownedRevision(db, user, cue.revisionId);
  const instruction = input.instruction ?? cue.instruction;
  const status = input.status ?? (cue.status === 'abstained' && input.instruction ? 'draft' : cue.status);
  if ((status === 'draft' || status === 'approved') && !instruction.trim()) throw badRequest('Write a direction before approving this cue');
  const decided = status === 'approved' || status === 'rejected';
  const [updated] = await db.update(landmarkCues).set({
    instruction, status, decidedBy: decided ? user.id : null, decidedAt: decided ? new Date() : null, updatedAt: new Date(),
  }).where(eq(landmarkCues.id, cue.id)).returning();
  return cueResponse(updated, true);
}

/** Approved cues for a share, in route order. Same access check as the share itself. */
export async function listShareCues(db: Db, user: AppUser | null, shareId: string) {
  const scan = await readShare(db, user, shareId);
  if (!scan.sourceRevisionId) return []; // manual uploads have no Gemini cues
  const rows = await db.select().from(landmarkCues)
    .where(and(eq(landmarkCues.revisionId, scan.sourceRevisionId), eq(landmarkCues.status, 'approved'))).orderBy(...inRouteOrder);
  return rows.map(row => cueResponse(row, scan.ownerId === user?.id));
}

/**
 * Saves Gemini's drafts for a revision (server-side; called by the Gemini step, not a route).
 * A turn the owner already approved or rejected keeps its decision and text; drafts and
 * abstentions are replaced with the newer result.
 */
export async function saveCueDrafts(db: Db, revisionId: string, drafts: unknown[]) {
  const parsed = z.array(cueDraftInput).max(500).parse(drafts);
  if (!parsed.length) return [];
  const id = uuid.parse(revisionId);
  const decided = await db.select({ segment: landmarkCues.routeSegmentId }).from(landmarkCues)
    .where(and(eq(landmarkCues.revisionId, id), inArray(landmarkCues.status, ['approved', 'rejected'])));
  const keep = new Set(decided.map(row => row.segment));
  const fresh = parsed.filter(draft => !keep.has(draft.routeSegmentId));
  if (!fresh.length) return [];
  return db.insert(landmarkCues).values(fresh.map(draft => ({
    revisionId: id, routeSegmentId: draft.routeSegmentId, sequence: draft.sequence, landmark: draft.landmark ?? null,
    instruction: draft.instruction, draftInstruction: draft.instruction || null, confidence: draft.confidence ?? null,
    status: draft.abstained ? 'abstained' as const : 'draft' as const, sourceFrameIds: draft.sourceFrameIds,
    model: draft.model ?? null, promptVersion: draft.promptVersion ?? null,
  }))).onConflictDoUpdate({
    target: [landmarkCues.revisionId, landmarkCues.routeSegmentId],
    set: { sequence: sql`excluded.sequence`, landmark: sql`excluded.landmark`, instruction: sql`excluded.instruction`,
      draftInstruction: sql`excluded.draft_instruction`, confidence: sql`excluded.confidence`, status: sql`excluded.status`,
      sourceFrameIds: sql`excluded.source_frame_ids`, model: sql`excluded.model`, promptVersion: sql`excluded.prompt_version`,
      updatedAt: new Date() },
  }).returning();
}
