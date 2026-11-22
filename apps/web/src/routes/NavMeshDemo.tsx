import { Line, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { BufferGeometry, Float32BufferAttribute } from "three";
import { buildNavMesh, DEFAULT_AGENT, trianglesFromObject, type Agent, type NavigationMesh, type Point } from "../lib/navmesh";
import { createRoom, disposeRoom } from "../lib/navmesh-room";

const initialStart = { x: -4, y: 0, z: -2 }, initialEnd = { x: 4, y: 0, z: -2 };
const tuple = (p: Point): [number, number, number] => [p.x, p.y + 0.09, p.z];
function Walkable({ navigation }: { navigation: NavigationMesh }) {
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(navigation.debug.positions, 3));
    g.setIndex(navigation.debug.indices); return g;
  }, [navigation]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry} position={[0, 0.025, 0]}>
    <meshBasicMaterial color="#40d8ac" transparent opacity={0.5} depthWrite={false} />
  </mesh>;
}

export default function NavMeshDemo() {
  const [agent, setAgent] = useState<Agent>(DEFAULT_AGENT);
  const [settings, setSettings] = useState<Agent>(DEFAULT_AGENT);
  const [closed, setClosed] = useState(false);
  const [debug, setDebug] = useState(true);
  const [start, setStart] = useState<Point>(initialStart), [end, setEnd] = useState<Point>(initialEnd);
  const [pick, setPick] = useState<"start" | "destination">("start");
  const [navigation, setNavigation] = useState<NavigationMesh | null>(null);
  const [error, setError] = useState<string | null>(null);
  const room = useMemo(() => createRoom({ closed }), [closed]);
  useEffect(() => () => disposeRoom(room), [room]);
  useEffect(() => {
    let cancelled = false, created: NavigationMesh | undefined;
    setNavigation(null); setError(null);
    void Promise.resolve().then(() => buildNavMesh(trianglesFromObject(room), agent)).then(value => {
      created = value;
      if (cancelled) value.dispose(); else setNavigation(value);
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Navigation could not be generated."); });
    return () => { cancelled = true; created?.dispose(); };
  }, [room, agent]);
  const route = useMemo(() => navigation?.route(start, end), [navigation, start, end]);
  const message = error ?? (!navigation ? "Generating walkable regions…" : route?.ok ? `Route ready · ${route.distance.toFixed(2)} m` : route?.message);
  return <main className="min-h-screen bg-night text-paper p-4 md:p-8">
    <a href="/spaces" className="underline">← Spaces and manual navigation</a>
    <h1 className="text-3xl mt-4 mb-2">Automatic room navigation</h1>
    <p>Synthetic room in metres. Green shows walkable surfaces; amber shows the route through the doorway.</p>
    <p className="my-2">Choose a point to set, then double-click the floor. Drag to orbit; scroll to zoom. Coordinates also work with a keyboard.</p>
    <div className="flex flex-wrap gap-4 my-4 items-end">
      <label>Set point <select className="bg-night border p-2" value={pick} onChange={e => setPick(e.target.value as typeof pick)}>
        <option value="start">Start</option><option value="destination">Destination</option>
      </select></label>
      {([['Start', start, setStart], ['Destination', end, setEnd]] as const).map(([name, p, setter]) =>
        <fieldset key={name} className="border p-2 flex gap-2"><legend>{name} (m)</legend>
          {(["x", "z"] as const).map(axis => <label key={axis}>{axis.toUpperCase()} <input className="bg-night border p-1 w-20" type="number" step="0.1"
            aria-label={`${name} ${axis}`} value={Number.isNaN(p[axis]) ? "" : p[axis]}
            onChange={e => setter({ ...p, [axis]: e.target.valueAsNumber })} /></label>)}
        </fieldset>)}
      <button className="border p-2" onClick={() => { setStart(initialStart); setEnd(initialEnd); }}>Reset points</button>
    </div>
    <details className="border p-3 mb-3"><summary>Agent clearance settings</summary>
      <form className="flex flex-wrap gap-4 mt-3" onSubmit={e => { e.preventDefault(); setAgent({ ...settings }); }}>
        {([{ key: "radius", label: "Radius (m)", min: 0.1, max: 1.5, step: 0.05 },
          { key: "height", label: "Height (m)", min: 0.5, max: 3, step: 0.05 },
          { key: "slope", label: "Maximum slope (°)", min: 0, max: 60, step: 1 },
          { key: "step", label: "Maximum step (m)", min: 0, max: 0.6, step: 0.05 }] as const).map(field =>
          <label key={field.key}>{field.label} <input className="bg-night border p-1 w-20" type="number" required {...{ min: field.min, max: field.max, step: field.step }}
            value={Number.isNaN(settings[field.key]) ? "" : settings[field.key]} onChange={e => setSettings({ ...settings, [field.key]: e.target.valueAsNumber })} /></label>)}
        <button className="border p-2">Rebuild NavMesh</button>
      </form>
    </details>
    <div className="flex flex-wrap gap-6 my-3">
      <label><input type="checkbox" checked={debug} onChange={e => setDebug(e.target.checked)} /> Show walkable overlay</label>
      <label><input type="checkbox" checked={closed} onChange={e => setClosed(e.target.checked)} /> Close doorway</label>
    </div>
    <p role={error || (route && !route.ok) ? "alert" : "status"} aria-live="polite" className="mb-3">{message}</p>
    <div className="border rounded" style={{ height: "min(65vh, 650px)", minHeight: 320 }}>
      <Canvas camera={{ position: [10, 15, 14], fov: 50 }} dpr={[1, 1.5]}
        aria-label="Synthetic room with wall, doorway, walkable regions and route"
        fallback={<p role="alert">WebGL is unavailable in this browser.</p>}>
        <color attach="background" args={["#121c16"]} />
        <ambientLight intensity={1.5} /><directionalLight position={[5, 10, 5]} intensity={2} />
        <primitive object={room} dispose={null} />
        {/* Only the floor is pickable. Obstacles remain visible and endpoint validation rejects their footprints. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]} onDoubleClick={e => {
          e.stopPropagation(); const p = { x: e.point.x, y: 0, z: e.point.z };
          if (pick === "start") { setStart(p); setPick("destination"); } else setEnd(p);
        }}><planeGeometry args={[12, 10]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
        {navigation && debug && <Walkable navigation={navigation} />}
        {route?.ok && route.points.length > 1 && <Line points={route.points.map(tuple)} color="#f7b955" lineWidth={5} />}
        {[start, end].map((p, i) => [p.x, p.y, p.z].every(Number.isFinite) && <mesh key={i} position={tuple(p)}>
          <sphereGeometry args={[0.14, 16, 12]} /><meshBasicMaterial color={i ? "#f7b955" : "#64d9b0"} />
        </mesh>)}
        <OrbitControls makeDefault target={[0, 0, 0]} maxPolarAngle={Math.PI / 2.1} />
      </Canvas>
    </div>
    <p className="mt-3">This geometry test does not certify a real building’s accessibility or safety. Existing saved routes stay in manual navigation.</p>
  </main>;
}
