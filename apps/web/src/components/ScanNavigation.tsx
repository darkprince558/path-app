import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { type Object3D } from "three";
import { buildNavMesh, DEFAULT_AGENT, MAX_NAV_VERTICES, MAX_NAV_TRIANGLES, trianglesFromObject, type NavigationMesh, type Point } from "../lib/navmesh";

import { routeDirections } from "../lib/route-directions";

export interface AutomaticState {
  navigation: NavigationMesh | null;
  points: Point[];
  pick(point: Point): void;
}

/** Models already contain their saved scan-to-space transform. */
/** Start and destination dots match the route's end markers in SpaceViewer. */
const START_COLOR = "#64D9B0", DESTINATION_COLOR = "#F7B955";

/**
 * A compact route card: two point buttons, one status line, and the details folded away.
 * `collapsed` keeps only the status line (the route and its state stay alive);
 * `children` go in the "Route options" fold (e.g. the NavMesh debug switch).
 */
export default function ScanNavigation({ objects, avoidStairs, approximate = false, collapsed = false, onChange, children }: {
  objects: Object3D[]; avoidStairs: boolean; approximate?: boolean; collapsed?: boolean;
  onChange: (state: AutomaticState | null) => void; children?: ReactNode;
}) {
  const [navigation, setNavigation] = useState<NavigationMesh | null>(null);
  const [error, setError] = useState("");
  const [start, setStart] = useState<Point | null>(null), [end, setEnd] = useState<Point | null>(null);
  const [pick, setPick] = useState<"start" | "destination">("start");
  const [pickError, setPickError] = useState("");
  useEffect(() => {
    let cancelled = false, created: NavigationMesh | undefined;
    setNavigation(null); setError(""); setStart(null); setEnd(null); setPick("start"); setPickError("");
    // Yield so the generating status paints before the bounded synchronous Recast build.
    const timer = setTimeout(() => {
      void (async () => {
        const input = { positions: [] as number[], indices: [] as number[] };
        for (const object of objects) {
          const triangles = trianglesFromObject(object), offset = input.positions.length / 3;
          for (const value of triangles.positions) input.positions.push(value);
          for (const index of triangles.indices) input.indices.push(index + offset);
          if (input.positions.length > MAX_NAV_VERTICES * 3 || input.indices.length > MAX_NAV_TRIANGLES * 3) throw new Error("Combined scans exceed the navigation geometry budget.");
        }
        const value = await buildNavMesh(input, { ...DEFAULT_AGENT, step: avoidStairs ? 0 : DEFAULT_AGENT.step });
        created = value;
        if (cancelled) value.dispose(); else setNavigation(value);
      })().catch(cause => { if (!cancelled) setError(`Automatic routing unavailable. ${cause instanceof Error ? cause.message : "Could not generate navigation."} Check that the scan contains an upright, continuous floor with enough clearance.`); });
    }, 0);
    return () => { clearTimeout(timer); cancelled = true; created?.dispose(); };
  }, [objects, avoidStairs]);
  const route = useMemo(() => navigation && start && end ? navigation.route(start, end) : null, [navigation, start, end]);
  useEffect(() => {
    onChange({ navigation, points: route?.ok ? route.points : start ? [start] : [], pick(point) {
      if (!navigation) return;
      const valid = navigation.route(point, point);
      if (!valid.ok) {
        setPickError("Choose a point on the walkable floor, away from walls and edges.");
        // A failed replacement must not leave a previous successful route visible.
        if (pick === "start") setStart(null); else setEnd(null);
        return;
      }
      setPickError("");
      if (pick === "start") { setStart(point); setEnd(null); setPick("destination"); } else setEnd(point);
    } });
  }, [navigation, route, start, pick, onChange]);
  useEffect(() => () => onChange(null), [onChange]);
  const message = error || pickError || (route && !route.ok ? route.message : "");
  // Minimised, the card shows one short line; open, it explains the next step.
  const tap = collapsed ? "Double-tap" : "Double-tap or double-click the floor";
  const status = !navigation ? "Finding the walkable floor…"
    : route?.ok ? `Route ready · ${approximate ? "≈ " : ""}${route.distance.toFixed(2)} m`
    : start ? `${collapsed ? "" : "Start selected. "}${tap} to set your destination.`
    : `${collapsed ? "" : "Walkable floor ready. "}${tap} to set your start.`;
  const clear = () => { setStart(null); setEnd(null); setPick("start"); setPickError(""); };
  const statusLine = message
    ? <p role="alert" className="text-sm text-coral">{message}</p>
    : <p role="status" className={`text-sm ${collapsed ? "truncate" : ""}`}>{status}</p>;
  if (collapsed) return <section aria-label="Automatic navigation">{statusLine}</section>;
  const point = (kind: "start" | "destination", label: string, set: boolean, color: string) =>
    <button type="button" aria-label={kind === "start" ? "Set start" : "Set destination"} aria-pressed={pick === kind}
      disabled={!navigation || (kind === "destination" && !start)} onClick={() => setPick(kind)}
      className={`flex min-h-11 items-center justify-center gap-2 rounded-lg px-2 text-sm font-bold ring-1 transition-colors disabled:opacity-40 ${
        pick === kind ? "bg-paper text-ink ring-paper" : "bg-night text-paper ring-sage/40"}`}>
      <span aria-hidden className="size-3 shrink-0 rounded-full"
        style={{ background: set ? color : "transparent", boxShadow: `inset 0 0 0 2px ${color}` }} />
      {label}
    </button>;
  return <section aria-label="Automatic navigation" className="space-y-2">
    <div className="grid grid-cols-2 gap-1.5">
      {point("start", "Start", !!start, START_COLOR)}
      {point("destination", "Destination", !!(route?.ok), DESTINATION_COLOR)}
    </div>
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">{statusLine}</div>
      {(start || pickError) && <button type="button" onClick={clear} aria-label="Clear route"
        className="-my-2.5 grid size-11 shrink-0 place-items-center rounded-full text-sage hover:bg-paper/10">
        <RotateCcw className="size-4" aria-hidden />
      </button>}
    </div>
    {route?.ok && <details className="text-sm">
      <summary className="cursor-pointer py-1 font-bold">Step-by-step directions</summary>
      <ol aria-label="Route directions" className="list-decimal space-y-0.5 pl-5">{routeDirections(route.points).map((step, i) => <li key={i}>{step}</li>)}</ol>
    </details>}
    {approximate && <p className="text-xs text-sage">Scale is unverified. This preview assumes the GLB uses metres and +Y up.</p>}
    <details className="text-xs text-sage">
      <summary className="cursor-pointer py-1">Route options</summary>
      <div className="space-y-1.5 pt-1">
        <p>Preview from scan geometry · 0.30 m radius, 1.80 m height{navigation && navigation.cellSize > 0.1 ? ` · ${Math.round(navigation.cellSize * 100)} cm grid for this large scan` : ""}. Verify the route against the room.</p>
        {children}
      </div>
    </details>
  </section>;
}
