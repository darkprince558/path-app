import type { Visibility } from "./scans";

/** One card in "Your maps" or "Community". */
export interface MapSummary {
  /** Share ID for real maps, or a "sample-" ID for placeholder cards. */
  id: string;
  name: string;
  visibility: Visibility;
  /** Set when someone else owns the map and shared it with you. */
  sharedBy?: string;
  /** Kind of place, matching the Explore chips planned in DESIGN.md. */
  place?: "Campus" | "Event" | "Hospital" | "Trail" | "Building";
  /** ISO date of the last change, if known. */
  updated?: string;
  /** Guest link for real maps. Sample cards have none. */
  sharePath?: string;
}

/**
 * Placeholder cards for "Your maps" and "Shared with me". The API can't list an
 * account's maps yet (it only has GET /api/scans/public), so these stand in until
 * Sam's API (#3) adds that. Real uploads don't appear here.
 */
export const SAMPLE_MAPS: MapSummary[] = [
  { id: "sample-eng-2", name: "Engineering building, 2nd floor", visibility: "public", place: "Campus", updated: "2026-11-20" },
  { id: "sample-hacker", name: "Hacker space and workshop rooms", visibility: "unlisted", place: "Event", updated: "2026-11-21" },
  { id: "sample-library", name: "Library study rooms", visibility: "private", place: "Building", updated: "2026-11-18" },
  { id: "sample-trail", name: "River trail loop", visibility: "public", place: "Trail", updated: "2026-11-15" },
  { id: "sample-student-centre", name: "Student centre", visibility: "unlisted", sharedBy: "Sam", place: "Campus", updated: "2026-11-19" },
  { id: "sample-clinic", name: "Campus clinic entrance", visibility: "private", sharedBy: "Anish", place: "Hospital", updated: "2026-11-17" },
];

export type MapFilter = "all" | "public" | "unlisted" | "private" | "shared";

export const MAP_FILTERS: { value: MapFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "public", label: "Public" },
  { value: "unlisted", label: "Unlisted" },
  { value: "private", label: "Private" },
  { value: "shared", label: "Shared with me" },
];

/** Public/Unlisted/Private filter your own maps. "Shared with me" shows maps others own. */
export function filterMaps(maps: MapSummary[], filter: MapFilter): MapSummary[] {
  if (filter === "all") return maps;
  if (filter === "shared") return maps.filter((m) => m.sharedBy);
  return maps.filter((m) => !m.sharedBy && m.visibility === filter);
}

/**
 * Where a map was opened from, carried in the router's location state so the map
 * page can offer "← Community" or "← Your maps". Maps opened from a shared link or
 * QR code have none, and show the Path logo instead.
 */
export interface MapOrigin {
  from: string;
  fromLabel: string;
  mapName?: string;
}

export function readMapOrigin(state: unknown): MapOrigin | null {
  const value = state as Partial<MapOrigin> | null;
  return value && typeof value.from === "string" && typeof value.fromLabel === "string"
    ? { from: value.from, fromLabel: value.fromLabel, mapName: value.mapName }
    : null;
}
