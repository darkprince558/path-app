import { apiFetch } from "./http.ts";
import { fetchMyMaps, mapEditId } from "./scans.ts";

/*
 * Map-card pictures. The first time the owner opens a 3D map that has no picture, the
 * viewer renders a small dollhouse view (SpaceViewer's onSnapshot) and saves it:
 *
 *   PUT /api/scans/<scanId>/thumbnail     image/jpeg, owner only
 *   GET /api/shares/<shareId>/thumbnail   anyone who can open the map; 404 until saved
 */

export const THUMBNAIL_WIDTH = 480;
export const THUMBNAIL_HEIGHT = 288; // 5:3, the cards' preview shape

export const thumbnailPath = (shareId: string) => `/api/shares/${encodeURIComponent(shareId)}/thumbnail`;

/**
 * The scan ID to save a picture under, when the signed-in visitor owns this map and it has
 * no picture yet. Null otherwise (most visits: one small 200 or 404 request).
 */
export async function thumbnailTarget(shareId: string, signal: AbortSignal): Promise<string | null> {
  try {
    const existing = await fetch(thumbnailPath(shareId), { credentials: "same-origin", cache: "no-store", signal });
    if (existing.status !== 404) return null;
    const mine = await fetchMyMaps(signal);
    const map = mine.find((entry) => entry.shareId === shareId);
    return map ? mapEditId(map) : null;
  } catch {
    return null;
  }
}

export async function saveThumbnail(scanId: string, picture: Blob): Promise<boolean> {
  try {
    const response = await apiFetch(`/api/scans/${encodeURIComponent(scanId)}/thumbnail`, {
      method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: picture,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Copies a region of a just-rendered WebGL canvas (top-left origin, drawing-buffer pixels)
 * into a 480 x 288 JPEG. Call it in the same task as the render: the WebGL buffer is
 * cleared once the frame is shown.
 */
export function encodeThumbnail(source: HTMLCanvasElement, x: number, y: number, width: number, height: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  context.drawImage(source, x, y, width, height, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
}
