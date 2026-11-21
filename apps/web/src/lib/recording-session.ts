import type { Take } from "./phone-recording";

const KEY = "path.recorder.key";
const JOB = "path.recorder.job";
const TAKE = "path.recorder.take";

export function organizerKey(): string {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("key");
  if (fromLink) {
    try { sessionStorage.setItem(KEY, fromLink); } catch { /* Use the key in memory for this visit. */ }
    history.replaceState(history.state, "", location.pathname + location.search);
    return fromLink;
  }
  try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; }
}
function tabTake(): string | null {
  try { return sessionStorage.getItem(TAKE); } catch { return null; }
}
function selectTake(id: string) {
  try { sessionStorage.setItem(TAKE, id); } catch { /* Keep working in memory. */ }
}
export function savedJob(draftId?: string): string {
  try {
    const id = draftId ?? tabTake();
    // A previous version kept one shared job pointer.
    const legacy = localStorage.getItem(JOB) || "";
    if (id === null) return legacy;
    return id && (localStorage.getItem(JOB + "." + id) || legacy === id) ? id : "";
  } catch { return ""; }
}
export function saveJob(id: string) {
  selectTake(id);
  try { localStorage.setItem(JOB + "." + id, "1"); } catch { /* The page can still track the job. */ }
}
export function forgetJob(id: string) {
  try {
    localStorage.removeItem(JOB + "." + id);
    if (localStorage.getItem(JOB) === id) localStorage.removeItem(JOB);
  } catch { /* Storage can be unavailable in private browsing. */ }
}

async function draftStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("path-recorder", 2);
    open.onupgradeneeded = (event) => {
      const store = event.oldVersion ? open.transaction!.objectStore("drafts") : open.result.createObjectStore("drafts");
      store.createIndex("savedAt", "savedAt");
      if (event.oldVersion === 1) {
        const legacy = store.get("current");
        legacy.onsuccess = () => {
          if (!legacy.result) return;
          store.put({ ...legacy.result, savedAt: Date.now() }, legacy.result.id);
          store.delete("current");
        };
      }
    };
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
export async function readTake(): Promise<Take | undefined> {
  const id = tabTake();
  if (id === "") return;
  if (id) return draftStore("readonly", (store) => store.get(id));
  const latest = await draftStore("readonly", (store) => store.index("savedAt").openCursor(null, "prev"));
  if (latest) selectTake(latest.value.id);
  return latest?.value;
}
export async function writeTake(take: Take) {
  selectTake(take.id);
  await draftStore("readwrite", (store) => store.put({ ...take, savedAt: Date.now() }, take.id));
}
export async function clearTake(id: string) {
  await draftStore("readwrite", (store) => store.delete(id));
  selectTake("");
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
