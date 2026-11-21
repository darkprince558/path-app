/**
 * Organizer-side calls from services/api/README.md.
 *
 *   POST  /api/scans?format=ply&visibility=unlisted  raw bytes -> 201 { shareId, sharePath }
 *   PATCH /api/scans/<shareId>  { visibility, viewerIds }    -> { shareId, visibility, viewerIds }
 *
 * Identity: the local mock reads an `X-Dev-User` header. In development we send one
 * (VITE_DEV_USER, default "organizer"). A production build sends none, because the
 * hosted API derives identity from the signed-in session instead.
 */

import type { ScanFormat } from "./shares";

export type { ScanFormat };
export type Visibility = "public" | "unlisted" | "private";

/** Matches the mock's upload limit. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Account IDs the mock accepts for viewers (and for X-Dev-User). */
export const VIEWER_ID_PATTERN = /^[a-zA-Z0-9_.@-]{1,64}$/;

export interface UploadResult {
  shareId: string;
  sharePath: string;
}

export interface SharingState {
  shareId: string;
  visibility: Visibility;
  viewerIds: string[];
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
  return { "X-Dev-User": import.meta.env.VITE_DEV_USER || "organizer" };
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
      return "Sign in as an organizer to upload scans.";
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
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<UploadResult> {
  const { file, format, visibility, onProgress, signal } = options;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ format, visibility });
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
            return resolve({ shareId: body.shareId, sharePath: body.sharePath });
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

export async function updateSharing(shareId: string, visibility: Visibility, viewerIds: string[]): Promise<SharingState> {
  let response: Response;
  try {
    response = await fetch(`/api/scans/${encodeURIComponent(shareId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...ownerHeaders() },
      body: JSON.stringify({ visibility, viewerIds }),
    });
  } catch {
    throw new UploadError("Couldn't reach the Path server. Your sharing setting didn't change.");
  }
  if (response.status === 404) {
    throw new UploadError("This scan no longer exists, or you aren't its organizer.", 404);
  }
  if (!response.ok) {
    const error = readError(await response.text());
    throw new UploadError(
      response.status === 400 && error
        ? `The server rejected that change: ${error}.`
        : `The server answered ${response.status}. Your sharing setting didn't change.`,
      response.status,
    );
  }
  return (await response.json()) as SharingState;
}

/** Splits "ana, sam  krish" into IDs and reports any the API would reject. */
export function parseViewerIds(text: string): { ids: string[]; invalid: string[] } {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const ids = [...new Set(parts.filter((p) => VIEWER_ID_PATTERN.test(p)))];
  const invalid = parts.filter((p) => !VIEWER_ID_PATTERN.test(p));
  return { ids, invalid };
}
