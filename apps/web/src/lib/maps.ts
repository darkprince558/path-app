import { mapEditId, type OwnedMap, type SharedMap, type Visibility } from "./scans";

/** One card in "Your maps" or "Community". */
export interface MapSummary {
  /** Share ID: the guest link and /maps/<id> use it. */
  id: string;
  /** For your own maps, the ID that edit and delete calls take (see mapEditId). */
  editId?: string;
  name: string;
  visibility: Visibility;
  /** Guest link. */
  sharePath: string;
  /** Set when someone else owns the map and shared it with you. */
  sharedBy?: string;
  /** Kind of place, matching the Explore chips planned in DESIGN.md. The API doesn't store it yet. */
  place?: "Campus" | "Event" | "Hospital" | "Trail" | "Building";
  /** ISO time of the last change, if known. */
  updated?: string;
  /** True for your own maps: the card offers rename, sharing and delete. */
  owned?: boolean;
}

export function fromOwned(map: OwnedMap): MapSummary {
  return {
    id: map.shareId,
    editId: mapEditId(map),
    name: map.name,
    visibility: map.visibility,
    sharePath: map.sharePath,
    updated: map.updatedAt,
    owned: true,
  };
}

export function fromShared(map: SharedMap): MapSummary {
  return {
    id: map.shareId,
    name: map.name,
    visibility: map.visibility,
    sharePath: map.sharePath,
    updated: map.updatedAt,
    sharedBy: map.owner,
  };
}

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
 * QR code have none, and show the Not 404 logo instead.
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
