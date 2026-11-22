import { apiFetch } from "./http.ts";
/**
 * Landmark cues ("Turn left at the purple mural."): Gemini drafts them from the scan's
 * photos, the map owner reviews them, and guests see only the approved ones.
 * Endpoints proposed by Sam (services/api), 2026-11-21:
 *
 *   GET   /api/scan-revisions/<revisionId>/cues -> { cues: Cue[] }  owner: drafts and decisions
 *   PATCH /api/cues/<cueId>  { instruction?, status? } -> { cue }    owner: edit, approve or reject
 *   GET   /api/shares/<shareId>/cues -> { cues: Cue[] }             guests: approved only
 *
 * Both lists come in route order (`sequence`), and the website sorts by it again.
 *
 * The share's metadata names its revision (`revisionId`). Maps uploaded as a file have none,
 * so they have no cues. Photos come from GET /api/shares/<shareId>/frames/<frameId>, which
 * only the owner may open.
 */


/** `abstained`: Gemini found no clear landmark, so the owner can type one or leave it. */
export type CueStatus = "draft" | "approved" | "rejected" | "abstained";
export type CueConfidence = "high" | "medium" | "low";

export interface Cue {
  id: string;
  routeSegmentId: string;
  /** The turn's position along the route. Lists are shown in this order. */
  sequence: number | null;
  landmark: string | null;
  instruction: string;
  confidence: CueConfidence | null;
  status: CueStatus;
  sourceFrameIds: string[];
}

export const MAX_INSTRUCTION_LENGTH = 200;

export class CueError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "CueError";
    this.status = status;
  }
}

const STATUSES: readonly CueStatus[] = ["draft", "approved", "rejected", "abstained"];
const CONFIDENCES: readonly CueConfidence[] = ["high", "medium", "low"];

/** Keeps well-formed cues only, so one odd row can't break the whole screen. */
function readCue(value: unknown): Cue | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.instruction !== "string") return null;
  if (!STATUSES.includes(v.status as CueStatus)) return null;
  return {
    id: v.id,
    routeSegmentId: typeof v.routeSegmentId === "string" ? v.routeSegmentId : "",
    sequence: typeof v.sequence === "number" && Number.isFinite(v.sequence) ? v.sequence : null,
    landmark: typeof v.landmark === "string" && v.landmark.trim() ? v.landmark : null,
    instruction: v.instruction,
    confidence: CONFIDENCES.includes(v.confidence as CueConfidence) ? (v.confidence as CueConfidence) : null,
    status: v.status as CueStatus,
    sourceFrameIds: Array.isArray(v.sourceFrameIds) ? v.sourceFrameIds.filter((id): id is string => typeof id === "string") : [],
  };
}

/** Route order, as Krishna's route turns number them. Cues without a position keep the server's order, last. */
function inRouteOrder(cues: Cue[]): Cue[] {
  return cues
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => (a.cue.sequence ?? Infinity) - (b.cue.sequence ?? Infinity) || a.index - b.index)
    .map(({ cue }) => cue);
}

async function readCues(response: Response): Promise<Cue[]> {
  const body = (await response.json()) as { cues?: unknown };
  return inRouteOrder(Array.isArray(body.cues) ? body.cues.map(readCue).filter((cue): cue is Cue => cue !== null) : []);
}

/** Trims and collapses spaces. Returns null when the instruction isn't allowed. */
export function cleanInstruction(value: string): string | null {
  const text = value.split(/\s+/).filter(Boolean).join(" ");
  // eslint-disable-next-line no-control-regex
  if (text.length < 1 || text.length > MAX_INSTRUCTION_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

/** The owner's cues for one processed scan, drafts included. */
export async function fetchRevisionCues(revisionId: string, signal?: AbortSignal): Promise<Cue[]> {
  let response: Response;
  try {
    response = await apiFetch(`/api/scan-revisions/${encodeURIComponent(revisionId)}/cues`, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new CueError("Couldn't reach the server.");
  }
  if (response.status === 401) throw new CueError("Sign in to review directions.", 401);
  if (response.status === 404) throw new CueError("This server has no directions for this map yet.", 404);
  if (!response.ok) throw new CueError(`The server answered ${response.status}.`, response.status);
  return readCues(response);
}

/** Edits, approves or rejects one cue. Only the owner may. */
export async function updateCue(
  id: string,
  change: { instruction?: string; status?: Exclude<CueStatus, "abstained"> },
): Promise<Cue> {
  let response: Response;
  try {
    response = await apiFetch(`/api/cues/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
  } catch {
    throw new CueError("Couldn't reach the server. Nothing changed.");
  }
  if (response.status === 404) throw new CueError("This direction no longer exists. Reload the page.", 404);
  if (!response.ok) throw new CueError(`The server answered ${response.status}. Nothing changed.`, response.status);
  const cue = readCue(((await response.json()) as { cue?: unknown }).cue);
  if (!cue) throw new CueError("Saved, but the server's reply was missing details. Reload to see it.");
  return cue;
}

/**
 * Approved directions a guest may see. Any failure gives an empty list: directions are
 * extra help, and the 3D map must still open without them.
 */
export async function fetchShareCues(shareId: string, signal?: AbortSignal): Promise<Cue[]> {
  try {
    const response = await apiFetch(`/api/shares/${encodeURIComponent(shareId)}/cues`, { signal });
    if (!response.ok) return [];
    return (await readCues(response)).filter((cue) => cue.status === "approved");
  } catch {
    return [];
  }
}

/** A cue's source photo. Owner-only on the server; guests never see photos. */
export function framePath(shareId: string, frameId: string): string {
  return `/api/shares/${encodeURIComponent(shareId)}/frames/${encodeURIComponent(frameId)}`;
}
