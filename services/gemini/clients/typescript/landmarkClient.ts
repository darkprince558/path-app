// Server-side client for the path-gemini service (services/gemini).
//
// For Sam's Next.js backend only. Never import this in browser code: it uses
// the shared service token. Copy it into services/api and set:
//   GEMINI_SERVICE_URL    e.g. http://127.0.0.1:8090 or http://path-gemini:8090
//   GEMINI_SERVICE_TOKEN  same value the service was started with

import type { Maneuver, Point, Heading, Turn } from "./turns.ts";

export type FrameRole = "approach" | "junction" | "exit";

export type LandmarkFrame = {
  frameId: string;
  role: FrameRole;
  mimeType: "image/jpeg" | "image/png";
  image: Uint8Array; // bytes read from private storage
  timestampSeconds?: number;
};

export type LandmarkRequest = {
  requestId: string;
  scanRevisionId: string;
  routeSegmentId: string; // e.g. a stable ID for this turn
  approachDirectionId: string; // opposite directions are separate requests
  waypoints?: { approachWaypointId: string; junctionWaypointId: string; exitWaypointId: string }; // graph routes only
  verifiedMovement: { maneuver: Exclude<Maneuver, "straight">; side?: "left" | "right"; instruction?: string };
  frames: LandmarkFrame[]; // 2 or 3, one per role
};

export type LandmarkCandidate = {
  landmark: string;
  landmarkType: string;
  visibleText: string | null;
  sourceFrameIds: string[];
  instruction: string; // DRAFT: organizer must approve before guests see it
  visibility: "clear" | "partial" | "uncertain";
  reason: string | null;
};

export type LandmarkResult = {
  requestId: string;
  category: "CANDIDATES" | "NO_CLEAR_LANDMARK";
  candidates: LandmarkCandidate[];
  abstained: boolean;
  abstentionReason: string | null;
  requiresReview: true;
  maneuver: Maneuver;
  side: "left" | "right" | null;
  frameIds: string[];
  model: string;
  promptVersion: string;
  elapsedMs: number;
  attempts: number;
  fingerprint: string; // use as the idempotency / cache key
  rawResponseText: string | null; // restricted audit field; never send to guests
  [extra: string]: unknown;
};

export type FrameSelection = {
  approach: string | null; junction: string | null; exit: string | null;
  usable: boolean; scores: Record<string, number | null>; consideredFrames: number;
};

export class GeminiServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** Worth retrying later (rate limit, outage, timeout). */
  get retryable() { return this.status === 503 || this.status === 504; }
}

type Options = { baseUrl?: string; token?: string; fetchImpl?: typeof fetch; timeoutMs?: number };

export class GeminiServiceClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: Options = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.GEMINI_SERVICE_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "");
    this.token = options.token ?? process.env.GEMINI_SERVICE_TOKEN ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 300_000; // Gemini can take a minute or more with retries
    if (!this.token) throw new Error("GEMINI_SERVICE_TOKEN is not set");
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(this.baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const e = (data as { error?: { code?: string; message?: string; details?: unknown } }).error ?? {};
      throw new GeminiServiceError(response.status, e.code ?? "HTTP_" + response.status, e.message ?? "Gemini service error", e.details ?? null);
    }
    return data as T;
  }

  /** Turn-by-turn list for a path (the same answer as turns.ts pathTurns). */
  turns(points: Point[]): Promise<{ turns: Turn[] }> {
    return this.post("/v1/turns", { points });
  }

  /** Pick approach/junction/exit photo IDs for one turn from frames.json entries. */
  selectFrames(turn: Pick<Turn, "position" | "incomingHeading" | "outgoingHeading" | "maneuver">,
               frames: unknown[], captureToSpace?: number[]): Promise<FrameSelection> {
    return this.post("/v1/frames/select", { turn, frames, captureToSpace });
  }

  /** Ask for landmark drafts. Abstention is a normal result, not an error. */
  proposeLandmarks(request: LandmarkRequest): Promise<LandmarkResult> {
    const { frames, ...rest } = request;
    return this.post("/v1/landmarks", {
      ...rest,
      frames: frames.map(({ image, ...f }) => ({ ...f, imageBase64: Buffer.from(image).toString("base64") })),
    });
  }
}

export type { Point, Heading };
