import { apiFetch, reportUnauthorized } from "./http.ts";
/**
 * Owner-side calls (upload, sharing) from services/api/README.md.
 *
 *   POST   /api/scans?format=ply&visibility=unlisted&name=…  raw bytes -> 201 { shareId, sharePath, name }
 *   GET    /api/scans/mine     -> { scans: OwnedMap[] }    (your maps)
 *   GET    /api/scans/shared   -> { scans: SharedMap[] }   (maps others added you to)
 *   PATCH  /api/scans/<shareId>  any of { name, visibility, viewerIds } -> SharingState
 *   DELETE /api/scans/<shareId>  -> 204
 *
 * Identity comes from the backend session cookie.
 */

import type { ScanFormat } from "./shares";

export type { ScanFormat };
export type Visibility = "public" | "unlisted" | "private";

/** Largest scan the website, Sam's API and the mock accept (keep in step with services/api MAX_GLB_BYTES). */
export const MAX_UPLOAD_BYTES = 400 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = "400 MB";

/** Account IDs the mock accepts for viewers (and for X-Dev-User). */
export const VIEWER_ID_PATTERN = /^[a-zA-Z0-9_.@-]{1,64}$/;

export const MAX_NAME_LENGTH = 80;
export const DEFAULT_MAP_NAME = "Untitled map";

export interface UploadResult {
  id?: string;
  shareId: string;
  sharePath: string;
  name: string;
}

export interface SharingState {
  shareId: string;
  name: string;
  visibility: Visibility;
  viewerIds: string[];
}

/** One of your own maps, from GET /api/scans/mine. */
export interface OwnedMap extends SharingState {
  /** The scan's own ID, used to edit and delete it. The Next.js API sends it; the local mock doesn't. */
  id?: string;
  sharePath: string;
  format: ScanFormat;
  updatedAt: string;
  /** The processed phone scan behind this map, for landmark cues. Null or missing for uploaded files. */
  revisionId?: string | null;
  /** People added to a private map, with names to show. The local mock sends only viewerIds. */
  viewers?: { id: string; displayName: string }[];
}

/**
 * The ID that PATCH and DELETE /api/scans/<id> expect: the scan's own ID on the Next.js API,
 * or the share ID on the local mock (which has no separate scan ID).
 */
export function mapEditId(map: { id?: string; shareId: string }): string {
  return map.id ?? map.shareId;
}

/** Names to show for the people who can open a private map. */
export function viewerNames(map: OwnedMap): string[] {
  return map.viewers?.map((viewer) => viewer.displayName) ?? map.viewerIds;
}

/** A map someone else owns and added you to, from GET /api/scans/shared. */
export interface SharedMap {
  shareId: string;
  sharePath: string;
  name: string;
  format: ScanFormat;
  visibility: Visibility;
  owner: string;
  updatedAt: string;
}

/** Trims and collapses spaces like the API does. Returns null when the name isn't allowed. */
export function cleanMapName(value: string): string | null {
  const name = value.split(/\s+/).filter(Boolean).join(" ");
  // eslint-disable-next-line no-control-regex
  if (name.length < 1 || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export class UploadError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

/** Builds the link a guest opens. Uses this site's origin so links stay on the website. */
export function shareUrl(sharePath: string): string {
  return new URL(sharePath, window.location.origin).toString();
}

export function formatForFile(file: File): ScanFormat | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".ply")) return "ply";
  if (name.endsWith(".glb")) return "glb";
  return null;
}

/**
 * Checks the first bytes before uploading so a wrong file fails immediately on the
 * phone instead of after a long upload. The server repeats the check.
 */
export async function checkFile(file: File): Promise<{ format: ScanFormat } | { problem: string }> {
  const format = formatForFile(file);
  if (!format) return { problem: "Choose a .ply point cloud or a .glb model." };
  if (file.size === 0) return { problem: "This file is empty." };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { problem: `This scan is ${formatBytes(file.size)}. The limit is ${MAX_UPLOAD_LABEL}, so crop or downsample it first.` };
  }
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const magic = String.fromCharCode(...head);
  if (format === "ply" && !magic.startsWith("ply")) {
    return { problem: "This file ends in .ply but isn't a PLY scan. Export it again from the capture app." };
  }
  if (format === "glb" && magic !== "glTF") {
    return { problem: "This file ends in .glb but isn't a binary glTF model. Export it again from the capture app." };
  }
  return { format };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function messageFor(status: number, serverError: string | undefined, format: ScanFormat): string {
  switch (status) {
    case 0:
      return "Couldn't reach the server. Check your connection and try again.";
    case 400:
      return serverError === "Invalid model header"
        ? `The server couldn't read this as a ${format.toUpperCase()} scan. Export it again from the capture app.`
        : `The server rejected the upload${serverError ? `: ${serverError}` : ""}.`;
    case 401:
      return "Sign in to upload scans.";
    case 413:
      return `This scan is over the ${MAX_UPLOAD_LABEL} limit. Crop or downsample it and try again.`;
    case 415:
      return "The server expected raw scan bytes. This is a bug in the website, not your file.";
    default:
      return `The server answered ${status}. Try again in a moment.`;
  }
}

/** Reads the mock's `{error: "..."}` and the Next.js API's `{error: {code, message}}`. */
function readError(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
    const message = (body.error as { message?: unknown } | undefined)?.message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

/** The Next.js API keeps a public map inside a public space and refuses otherwise. */
const PUBLIC_SPACE_RULE = /public scan requires a public space/i;

/** Uploads with XMLHttpRequest because fetch can't report upload progress. */
export function uploadScan(options: {
  file: File;
  format: ScanFormat;
  visibility: Visibility;
  name?: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<UploadResult> {
  const { file, format, visibility, name, onProgress, signal } = options;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ format, visibility, ...(name ? { name } : {}) });
    xhr.open("POST", `/api/scans?${query}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      reportUnauthorized(xhr.status);
      if (xhr.status === 201) {
        try {
          const body = JSON.parse(xhr.responseText) as Partial<UploadResult>;
          if (typeof body.shareId === "string" && typeof body.sharePath === "string") {
            return resolve({
              ...(typeof body.id === "string" ? { id: body.id } : {}),
              shareId: body.shareId,
              sharePath: body.sharePath,
              name: typeof body.name === "string" ? body.name : (name ?? DEFAULT_MAP_NAME),
            });
          }
        } catch {
          // fall through
        }
        return reject(new UploadError("The upload finished but the server's reply was missing the link.", 201));
      }
      reject(new UploadError(messageFor(xhr.status, readError(xhr.responseText), format), xhr.status));
    };
    xhr.onerror = () => reject(new UploadError(messageFor(0, undefined, format)));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });

    xhr.send(file);
  });
}

/**
 * Changes a map's name or visibility. Only the owner may. `mapId` comes from mapEditId().
 * Adding or removing viewers isn't offered yet: the Next.js API keeps grants by account
 * UUID, and a proper people picker comes after the demo.
 */
export async function updateMap(
  mapId: string,
  change: Partial<Pick<SharingState, "name" | "visibility">>,
): Promise<Pick<SharingState, "shareId" | "name" | "visibility">> {
  const what = "name" in change && Object.keys(change).length === 1 ? "name" : "sharing setting";
  let response: Response;
  try {
    response = await apiFetch(`/api/scans/${encodeURIComponent(mapId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
  } catch {
    throw new UploadError(`Couldn't reach the server. The ${what} didn't change.`);
  }
  if (response.status === 404) {
    throw new UploadError("This map no longer exists, or it was uploaded from a different account.", 404);
  }
  if (!response.ok) {
    const error = readError(await response.text());
    throw new UploadError(
      response.status === 400 && error && PUBLIC_SPACE_RULE.test(error)
        ? "To make this map public, its parent space must also be public."
        : response.status === 400 && error
          ? `The server rejected that change: ${error}.`
          : `The server answered ${response.status}. The ${what} didn't change.`,
      response.status,
    );
  }
  // The mock answers with the sharing state; the Next.js API wraps the scan as {scan}.
  const body = (await response.json()) as Partial<SharingState> & { scan?: Partial<SharingState> };
  const state = body.scan ?? body;
  if (typeof state.shareId !== "string" || typeof state.name !== "string" || typeof state.visibility !== "string") {
    throw new UploadError(`The change was saved, but the server's reply was missing details. Reload to see it.`);
  }
  return { shareId: state.shareId, name: state.name, visibility: state.visibility };
}

export function updateSharing(mapId: string, visibility: Visibility) {
  return updateMap(mapId, { visibility });
}

/** Deletes a map for good. Only the owner may. `mapId` comes from mapEditId(). */
export async function deleteMap(mapId: string): Promise<void> {
  let response: Response;
  try {
    response = await apiFetch(`/api/scans/${encodeURIComponent(mapId)}`, { method: "DELETE" });
  } catch {
    throw new UploadError("Couldn't reach the server. The map wasn't deleted.");
  }
  if (response.status === 404) {
    throw new UploadError("This map is already gone, or it was uploaded from a different account.", 404);
  }
  if (!response.ok) throw new UploadError(`The server answered ${response.status}. The map wasn't deleted.`, response.status);
}

/** Thrown when the server has no route for listing maps yet (the hosted API before #3 adds it). */
export class ListUnavailableError extends Error {}

async function fetchList<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  let response: Response;
  try {
    response = await apiFetch(path, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new UploadError("Couldn't reach the server.");
  }
  if (response.status === 404) throw new ListUnavailableError("This server can't list maps yet.");
  if (response.status === 401) throw new UploadError("Sign in to see your maps.", 401);
  if (!response.ok) throw new UploadError(`The server answered ${response.status}.`, response.status);
  const body = (await response.json()) as { scans?: T[] };
  return body.scans ?? [];
}

export const fetchMyMaps = (signal?: AbortSignal) => fetchList<OwnedMap>("/api/scans/mine", signal);
export const fetchSharedMaps = (signal?: AbortSignal) => fetchList<SharedMap>("/api/scans/shared", signal);

