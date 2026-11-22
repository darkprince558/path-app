import { useEffect, useMemo, useState } from "react";
import { type Object3D } from "three";
import { buildNavMesh, DEFAULT_AGENT, trianglesFromObject, type NavigationMesh, type Point } from "../lib/navmesh";

export interface AutomaticState {
  navigation: NavigationMesh | null;
  points: Point[];
  pick(point: Point): void;
}

/** Runs only after opt-in. Models already contain the approved scan-to-space transform. */
export default function ScanNavigation({ objects, avoidStairs, onChange }: {
  objects: Object3D[]; avoidStairs: boolean; onChange: (state: AutomaticState | null) => void;
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
          if (input.positions.length > 1_800_000 || input.indices.length > 600_000) throw new Error("Combined scans exceed the navigation geometry budget.");
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
  return <section aria-label="Automatic navigation" className="space-y-2">
    <p className="text-sm">Double-click or double-tap the floor to set {pick}. Drag to orbit.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="border rounded px-2 py-1" disabled={!navigation} aria-pressed={pick === "start"} onClick={() => setPick("start")}>Set start</button>
      <button type="button" className="border rounded px-2 py-1" disabled={!navigation || !start} aria-pressed={pick === "destination"} onClick={() => setPick("destination")}>Set destination</button>
      <button type="button" className="border rounded px-2 py-1" onClick={() => { setStart(null); setEnd(null); setPick("start"); setPickError(""); }}>Clear route</button>
    </div>
    {message ? <p role="alert">{message}</p> : <p role="status">{!navigation ? "Generating walkable floor…" : route?.ok ? `Route ready · ${route.distance.toFixed(2)} m` : start ? "Start selected. Choose a destination." : "Walkable floor ready. Choose a start."}</p>}
    <p className="text-xs">Preview from scan geometry · 0.30 m radius, 1.80 m height. Verify the route against the room.</p>
  </section>;
}
