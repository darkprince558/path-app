/**
 * Owner-side calls (upload, sharing) from services/api/README.md.
 *
 *   POST   /api/scans?format=ply&visibility=unlisted&name=…  raw bytes -> 201 { shareId, sharePath, name }
 *   GET    /api/scans/mine     -> { scans: OwnedMap[] }    (your maps)
 *   GET    /api/scans/shared   -> { scans: SharedMap[] }   (maps others added you to)
 *   PATCH  /api/scans/<shareId>  any of { name, visibility, viewerIds } -> SharingState
 *   DELETE /api/scans/<shareId>  -> 204
 *
 * Identity: the local mock reads an `X-Dev-User` header. In development we send one
 * (VITE_DEV_USER, default "demo-owner"). A production build sends none, because the
 * hosted API derives identity from the signed-in session instead.
 */

import { currentUser } from "./session";
import type { ScanFormat } from "./shares";

export type { ScanFormat };
export type Visibility = "public" | "unlisted" | "private";

/** Matches the mock's upload limit. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Account IDs the mock accepts for viewers (and for X-Dev-User). */
export const VIEWER_ID_PATTERN = /^[a-zA-Z0-9_.@-]{1,64}$/;

export const MAX_NAME_LENGTH = 80;
export const DEFAULT_MAP_NAME = "Untitled map";

export interface UploadResult {
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
  sharePath: string;
  format: ScanFormat;
  updatedAt: string;
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

export function ownerHeaders(): Record<string, string> {
  if (!import.meta.env.DEV) return {};
  return { "X-Dev-User": currentUser().id };
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
    return { problem: `This scan is ${formatBytes(file.size)}. The limit is 32 MB, so crop or downsample it first.` };
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
      return "Couldn't reach the Path server. Check your connection and try again.";
    case 400:
      return serverError === "Invalid model header"
        ? `The server couldn't read this as a ${format.toUpperCase()} scan. Export it again from the capture app.`
        : `The server rejected the upload${serverError ? `: ${serverError}` : ""}.`;
    case 401:
      return "Sign in to upload scans.";
    case 413:
      return "This scan is over the 32 MB limit. Crop or downsample it and try again.";
    case 415:
      return "The server expected raw scan bytes. This is a bug in the website, not your file.";
    default:
      return `The server answered ${status}. Try again in a moment.`;
  }
}

function readError(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

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
    for (const [name, value] of Object.entries(ownerHeaders())) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status === 201) {
        try {
          const body = JSON.parse(xhr.responseText) as Partial<UploadResult>;
          if (typeof body.shareId === "string" && typeof body.sharePath === "string") {
            return resolve({
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

/** Changes any of a map's name, visibility and viewer list. Only the owner may. */
export async function updateMap(
  shareId: string,
  change: Partial<Pick<SharingState, "name" | "visibility" | "viewerIds">>,
): Promise<SharingState> {
  const what = "name" in change && Object.keys(change).length === 1 ? "name" : "sharing setting";
  let response: Response;
  try {
    response = await fetch(`/api/scans/${encodeURIComponent(shareId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...ownerHeaders() },
      body: JSON.stringify(change),
    });
  } catch {
    throw new UploadError(`Couldn't reach the Path server. The ${what} didn't change.`);
  }
  if (response.status === 404) {
    throw new UploadError("This map no longer exists, or it was uploaded from a different account.", 404);
  }
  if (!response.ok) {
    const error = readError(await response.text());
    throw new UploadError(
      response.status === 400 && error
        ? `The server rejected that change: ${error}.`
        : `The server answered ${response.status}. The ${what} didn't change.`,
      response.status,
    );
  }
  return (await response.json()) as SharingState;
}

export function updateSharing(shareId: string, visibility: Visibility, viewerIds: string[]): Promise<SharingState> {
  return updateMap(shareId, { visibility, viewerIds });
}

/** Deletes a map for good. Only the owner may. */
export async function deleteMap(shareId: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/scans/${encodeURIComponent(shareId)}`, { method: "DELETE", headers: ownerHeaders() });
  } catch {
    throw new UploadError("Couldn't reach the Path server. The map wasn't deleted.");
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
    response = await fetch(path, { headers: ownerHeaders(), signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new UploadError("Couldn't reach the Path server.");
  }
  if (response.status === 404) throw new ListUnavailableError("This server can't list maps yet.");
  if (response.status === 401) throw new UploadError("Sign in to see your maps.", 401);
  if (!response.ok) throw new UploadError(`The server answered ${response.status}.`, response.status);
  const body = (await response.json()) as { scans?: T[] };
  return body.scans ?? [];
}

export const fetchMyMaps = (signal?: AbortSignal) => fetchList<OwnedMap>("/api/scans/mine", signal);
export const fetchSharedMaps = (signal?: AbortSignal) => fetchList<SharedMap>("/api/scans/shared", signal);

/** Splits "ana, sam  krish" into IDs and reports any the API would reject. */
export function parseViewerIds(text: string): { ids: string[]; invalid: string[] } {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const ids = [...new Set(parts.filter((p) => VIEWER_ID_PATTERN.test(p)))];
  const invalid = parts.filter((p) => !VIEWER_ID_PATTERN.test(p));
  return { ids, invalid };
}
