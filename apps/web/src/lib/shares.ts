/**
 * Client for the share endpoints in services/api/README.md.
 *
 *   GET /api/shares/<shareId>        -> { shareId, format, assetPath }
 *   GET /api/shares/<shareId>/asset  -> the uploaded file (same access check)
 *
 * The API answers 404 both for an unknown share and for a private share the
 * viewer may not open, so the UI treats those as one "not found or no access" state.
 */

export type ScanFormat = "ply" | "glb";

export interface ShareMetadata {
  shareId: string;
  format: ScanFormat;
  assetPath: string;
  /** Map name. Older servers don't send it. */
  name?: string;
  /** Column-major 4x4 scan-to-space matrix. The mock omits it (identity). */
  transform?: number[];
  scanId?: string;
  metadata?: { coordinateSystem?: { units: "relative" | "metres"; upAxis: "Y"; calibrated?: boolean }; alignmentVerified?: boolean };
}

export type ShareErrorKind = "not-found" | "network" | "server" | "bad-response";

export class ShareError extends Error {
  readonly kind: ShareErrorKind;
  readonly status?: number;

  constructor(kind: ShareErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ShareError";
    this.kind = kind;
    this.status = status;
  }
}

async function request(url: string, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { signal, credentials: "same-origin" });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ShareError("network", "Couldn't reach the server.");
  }
  if (response.status === 404) {
    throw new ShareError("not-found", "This scan link doesn't exist or isn't shared with you.", 404);
  }
  if (!response.ok) {
    throw new ShareError("server", `The server answered ${response.status}.`, response.status);
  }
  return response;
}

function isShareMetadata(value: unknown): value is ShareMetadata {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.shareId === "string" &&
    (v.format === "ply" || v.format === "glb") &&
    typeof v.assetPath === "string" &&
    v.assetPath.length > 0 &&
    (v.transform === undefined || (Array.isArray(v.transform) && v.transform.length === 16 && v.transform.every(Number.isFinite)))
  );
}

export async function fetchShare(shareId: string, signal: AbortSignal): Promise<ShareMetadata> {
  const response = await request(`/api/shares/${encodeURIComponent(shareId)}`, signal);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ShareError("bad-response", "The share details weren't valid JSON.");
  }
  if (!isShareMetadata(body)) {
    throw new ShareError("bad-response", "The share details were missing a format or asset path.");
  }
  return body;
}

/** Fetches the scan bytes. `assetPath` may be relative to this site or an absolute URL. */
export async function fetchAsset(assetPath: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const url = new URL(assetPath, window.location.origin).toString();
  const response = await request(url, signal);
  try {
    return await response.arrayBuffer();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ShareError("network", "The scan download was interrupted.");
  }
}
