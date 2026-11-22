/**
 * Named places pinned on a map ("Room 2", "Washroom"), so a first-time visitor can see what is
 * where and pick a destination. The owner adds them on Manage map; everyone who can open the
 * map sees them on the 3D model.
 *
 *   GET    /api/shares/<shareId>/places -> { places: Place[] }   anyone who may open the map
 *   POST   /api/scans/<mapId>/places    { name, category, position } -> { place }   owner
 *   PATCH  /api/places/<id>             { name?, category?, position? } -> { place }   owner
 *   DELETE /api/places/<id>                                                       owner
 *
 * `position` is in the model's own coordinates (the GLB before the map's saved alignment), so
 * a pin stays on its spot if the map is re-aligned.
 */

import { apiFetch } from "./http";
import {
  PlaceError, readPlace, sortPlaces,
  type Place, type PlaceCategory, type PlacePosition,
} from "./place-rules";

export * from "./place-rules";

async function placeJson(response: Response): Promise<Place> {
  const place = readPlace(((await response.json().catch(() => ({}))) as { place?: unknown }).place);
  if (!place) throw new PlaceError("Saved, but the server's reply was missing details. Reload to see it.");
  return place;
}

async function call(url: string, init: RequestInit, failure: string): Promise<Response> {
  let response: Response;
  try {
    response = await apiFetch(url, init);
  } catch {
    throw new PlaceError(`Couldn't reach the server. ${failure}`);
  }
  if (response.status === 401) throw new PlaceError("Sign in again to edit places.", 401);
  if (response.status === 403 || response.status === 404) throw new PlaceError("Only the map's owner can change its places.", response.status);
  if (response.status === 409) throw new PlaceError("This map already has the most places allowed.", 409);
  if (response.status === 400) throw new PlaceError("Check the name and type, then try again.", 400);
  if (!response.ok) throw new PlaceError(`The server answered ${response.status}. ${failure}`, response.status);
  return response;
}

/**
 * Places on a map. For guests any failure gives an empty list: labels are extra help and the
 * 3D map must still open without them. Pass `strict` to get errors (the owner's editor).
 */
export async function fetchPlaces(shareId: string, signal?: AbortSignal, strict = false): Promise<Place[]> {
  try {
    const response = await apiFetch(`/api/shares/${encodeURIComponent(shareId)}/places`, { signal });
    if (!response.ok) {
      if (strict) throw new PlaceError(response.status === 404 ? "This server doesn't support places yet." : `The server answered ${response.status}.`, response.status);
      return [];
    }
    const body = (await response.json()) as { places?: unknown };
    return sortPlaces(Array.isArray(body.places) ? body.places.map(readPlace).filter((p): p is Place => p !== null) : []);
  } catch (error) {
    if (signal?.aborted || (strict && error instanceof PlaceError)) throw error;
    if (strict) throw new PlaceError("Couldn't reach the server.");
    return [];
  }
}

export async function createPlace(mapId: string, input: { name: string; category: PlaceCategory; position: PlacePosition }): Promise<Place> {
  const response = await call(`/api/scans/${encodeURIComponent(mapId)}/places`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }, "The place wasn't added.");
  return placeJson(response);
}

export async function updatePlace(id: string, change: { name?: string; category?: PlaceCategory; position?: PlacePosition }): Promise<Place> {
  const response = await call(`/api/places/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change),
  }, "Nothing changed.");
  return placeJson(response);
}

export async function deletePlace(id: string): Promise<void> {
  await call(`/api/places/${encodeURIComponent(id)}`, { method: "DELETE" }, "The place is still there.");
}
