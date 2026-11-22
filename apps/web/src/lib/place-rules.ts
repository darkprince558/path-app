/** Place rules with no imports, so Node tests can load them directly. See places.ts. */

export const PLACE_CATEGORIES = [
  "room", "entrance", "exit", "washroom", "stairs", "elevator", "office", "food", "info", "other",
] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<PlaceCategory, string> = {
  room: "Room", entrance: "Entrance", exit: "Exit", washroom: "Washroom", stairs: "Stairs",
  elevator: "Elevator", office: "Office", food: "Food", info: "Info desk", other: "Other",
};

export interface PlacePosition { x: number; y: number; z: number }

export interface Place {
  id: string;
  name: string;
  category: PlaceCategory;
  position: PlacePosition;
}

export const MAX_PLACE_NAME_LENGTH = 80;

export class PlaceError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "PlaceError";
    this.status = status;
  }
}

/** Trims and collapses spaces. Null when the name isn't allowed. */
export function cleanPlaceName(value: string): string | null {
  const name = value.split(/\s+/).filter(Boolean).join(" ");
  if (!name || name.length > MAX_PLACE_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Keeps well-formed places only, so one odd row can't break the map. */
export function readPlace(value: unknown): Place | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const p = v.position as Record<string, unknown> | undefined;
  if (typeof v.id !== "string" || typeof v.name !== "string" || !v.name.trim()) return null;
  if (!p || !finite(p.x) || !finite(p.y) || !finite(p.z)) return null;
  const category = PLACE_CATEGORIES.includes(v.category as PlaceCategory) ? (v.category as PlaceCategory) : "other";
  return { id: v.id, name: v.name, category, position: { x: p.x, y: p.y, z: p.z } };
}

/** Sorted by name, like the server. */
export function sortPlaces(places: Place[]): Place[] {
  return [...places].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.id.localeCompare(b.id));
}

/** Why sharing beyond Private is locked, or null when the map has enough places. */
export function sharingLockReason(placeCount: number | null): string | null {
  if (placeCount === null || placeCount > 0) return null;
  return "Label at least one place (for example the entrance) before sharing, so visitors know where things are.";
}
