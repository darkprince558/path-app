import type { Take } from "./phone-recording";

const KEY = "path.recorder.key";
const JOB = "path.recorder.job";

export function organizerKey(): string {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("key");
  if (fromLink) {
    try { sessionStorage.setItem(KEY, fromLink); } catch { /* Use the key in memory for this visit. */ }
    history.replaceState(history.state, "", location.pathname + location.search);
    return fromLink;
  }
  try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; }
}
export function savedJob(): string {
  try { return localStorage.getItem(JOB) || ""; } catch { return ""; }
}
export function saveJob(id: string) {
  try {
    if (id) localStorage.setItem(JOB, id);
    else localStorage.removeItem(JOB);
  } catch { /* The current page can still track the job. */ }
}

async function draftStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("path-recorder", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("drafts");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("drafts", mode);
      const req = action(tx.objectStore("drafts"));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = tx.onerror = () => reject(tx.error || req.error);
    });
  } finally {
    db.close();
  }
}
export function readTake(): Promise<Take | undefined> {
  return draftStore("readonly", (store) => store.get("current"));
}
export function writeTake(take: Take) {
  return draftStore("readwrite", (store) => store.put(take, "current"));
}
export function clearTake() {
  return draftStore("readwrite", (store) => store.delete("current"));
}

export interface CaptureStatus {
  status: "uploading" | "queued" | "processing" | "ready" | "failed";
  stage?: string;
  error?: string;
  sharePath?: string;
  motionSummary?: {
    registeredFrames?: number;
    sampledFrames?: number;
    supportedFraction?: number;
    samplingReason?: string;
    missingIntervalsSeconds?: [number, number][];
  };
}
export class CaptureRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function captureRequest(
  key: string, id: string, suffix: string, method: string, signal: AbortSignal, body?: Blob | string,
): Promise<CaptureStatus> {
  const headers: Record<string, string> = { Authorization: "Bearer " + key };
  if (typeof body === "string") headers["Content-Type"] = "application/json";
  if (body instanceof Blob) headers["Content-Type"] = body.type.split(";")[0] || "video/mp4";
  const response = await fetch("/api/captures/" + encodeURIComponent(id) + suffix, {
    method, headers, body, signal, credentials: "omit", redirect: "error", cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CaptureRequestError(response.status, "Open the current organizer recorder link from your Mac.");
    }
    throw new CaptureRequestError(response.status, typeof result.error === "string" ? result.error : "The Mac could not complete the request.");
  }
  if (!["uploading", "queued", "processing", "ready", "failed"].includes(result.status)) {
    throw new Error("The Mac returned an unexpected recording status.");
  }
  return result;
}

export function shareUrl(path?: string): string {
  if (!path || !/^\/s\/[A-Za-z0-9_-]+$/.test(path)) return "";
  return new URL(path, location.origin).href;
}
