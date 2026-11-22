import { apiFetch } from "./http.ts";
export type Visibility = "public" | "private";
export type Position = { x: number; y: number; z: number };
export type CoordinateSystem = { units: "relative" | "metres"; upAxis: "Y"; calibrated: boolean };
export interface Space { id: string; ownerId: string; name: string; visibility: Visibility; boundary: Record<string, unknown> | null }
export interface Scan { sourceRevisionId?: string | null; id: string; spaceId: string; name: string; format: string; status: string; visibility: Visibility; transform: number[]; metadata: Record<string, unknown>; downloadPath: string | null }
export interface NavNode extends Position { id: string; spaceId: string; metadata?: Record<string, unknown> }
export interface NavEdge { id: string; spaceId: string; fromNodeId: string; toNodeId: string; distance: number; bidirectional: boolean; accessible: boolean }
export interface Destination { id: string; spaceId: string; nodeId: string; name: string }
export interface Graph { spaceId: string; nodes: NavNode[]; edges: NavEdge[]; destinations: Destination[] }
export interface SavedPath { id: string; spaceId: string; name: string; visibility: Visibility; waypoints?: { nodeId: string; sequence: number }[] }
export interface User { id: string; displayName: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await apiFetch(url, { credentials: "same-origin", cache: "no-store", ...options });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, value?.error?.message ?? `Request failed (${response.status}).`);
  return value as T;
}

export function send<T>(url: string, method: string, value: unknown): Promise<T> {
  return request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
}

export function coordinates(space: Space): CoordinateSystem {
  const info = space.boundary?.coordinateSystem as Partial<CoordinateSystem> | undefined;
  // Older spaces declare no calibration evidence. Never infer metres from a GLB.
  return info?.units === "metres" && info.calibrated === true
    ? { units: "metres", upAxis: "Y", calibrated: true }
    : { units: "relative", upAxis: "Y", calibrated: false };
}

export function scanAligned(scan: Scan, space: Space): boolean {
  const declared = scan.metadata.coordinateSystem as Partial<CoordinateSystem> | undefined;
  const frame = coordinates(space);
  return scan.metadata.alignmentVerified === true && declared?.units === frame.units && declared.upAxis === "Y"
    && (frame.units !== "metres" || declared.calibrated === true);
}

export function nodeLabel(node: NavNode, graph: Graph): string {
  const place = graph.destinations.find(d => d.nodeId === node.id);
  return place?.name ?? (typeof node.metadata?.name === "string" ? node.metadata.name : `Node ${graph.nodes.indexOf(node) + 1}`);
}

export async function scanBytes(scan: Scan, signal: AbortSignal): Promise<ArrayBuffer> {
  // Asset URLs are always the same-origin, authorized API route for this scan.
  const expected = `/api/scans/${encodeURIComponent(scan.id)}/file`;
  if (scan.downloadPath !== expected) throw new Error(`Invalid download path for ${scan.name}.`);
  const response = await apiFetch(expected, { signal, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new ApiError(response.status, `Could not download ${scan.name} (${response.status}).`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("This scan exceeds the 32 MiB viewer limit.");
  return bytes;
}
