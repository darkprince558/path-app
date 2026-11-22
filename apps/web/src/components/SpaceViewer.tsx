import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box3, DoubleSide, BufferGeometry, Float32BufferAttribute, MathUtils, MOUSE, Sphere, TOUCH, Vector3, type Object3D } from "three";
import { parseGlb, type GlbModel } from "../lib/glb";
import { prepareScanSurfaces, type ScanSurfaces } from "../lib/scan-surfaces";
import type { AutomaticState } from "./ScanNavigation";
const ScanNavigation = lazy(() => import("./ScanNavigation"));
import type { NavigationMesh } from "../lib/navmesh";

export function NavMeshOverlay({ navigation }: { navigation: NavigationMesh }) {
  const geometry = useMemo(() => {
    const value = new BufferGeometry();
    value.setAttribute("position", new Float32BufferAttribute(navigation.debug.positions, 3));
    value.setIndex(navigation.debug.indices); return value;
  }, [navigation]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry} position={[0, 0.025, 0]} raycast={() => {}}>
    <meshBasicMaterial side={DoubleSide} color="#40d8ac" transparent opacity={0.5} depthWrite={false} polygonOffset polygonOffsetFactor={-1} />
  </mesh>;
}


export interface SpaceModel {
  id: string;
  name?: string;
  bytes: ArrayBuffer;
  transform: number[];
}
export interface ViewerNode { id: string; x: number; y: number; z: number }
/** A named place pinned on a model. `local` is in that model's own coordinates. */
export interface ViewerPlace { id: string; name: string; categoryLabel: string; local: { x: number; y: number; z: number }; scanId?: string }
export interface ViewerEdge { id: string; fromNodeId: string; toNodeId: string }
interface Position { x: number; y: number; z: number }
export interface ModelPick { scanId: string; point: Position; localPoint: Position }
export interface SpaceViewerProps {
  models: SpaceModel[];
  nodes: ViewerNode[];
  edges: ViewerEdge[];
  route?: ViewerNode[];
  showGraph?: boolean;
  resetToken?: number;
  automaticNavigation?: boolean;
  initialAutomaticNavigation?: boolean;
  navigationApproximate?: boolean;
  navigationUnavailable?: string;
  avoidStairs?: boolean;
  onAutomaticChange?: (enabled: boolean) => void;
  /** Double-click a model to select a surface point. Coordinates are space-local. */
  onPick?: (pick: ModelPick) => void;
  /** Named places to pin on the models, with a floating label each. */
  places?: ViewerPlace[];
  /** The place to emphasise, for example the one being edited. */
  highlightPlaceId?: string | null;
  /** A place's label was pressed. With automatic routing on, it also sets the start or destination. */
  onPlaceSelect?: (placeId: string) => void;
  onError?: (message: string) => void;
  onReady?: () => void;
}
interface LoadedModel { id: string; model: GlbModel }
interface OrbitLike { target: Vector3; minDistance: number; maxDistance: number; update(): void }

function Framing({ bounds, resetToken }: { bounds: Sphere; resetToken: number }) {
  const { camera, controls, size } = useThree();
  useEffect(() => {
    const orbit = controls as unknown as OrbitLike | null;
    const perspective = camera as typeof camera & { fov?: number; aspect?: number };
    const vertical = MathUtils.degToRad(perspective.fov ?? 55);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * (size.width / Math.max(size.height, 1)));
    const radius = Math.max(bounds.radius, 0.001);
    const distance = radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.1;
    // A dollhouse view: about 50° down from the entrance side (+Z), so corridors read from above.
    camera.position.copy(bounds.center).add(new Vector3(0, distance * 0.77, distance * 0.64));
    camera.near = Math.max(radius / 1000, 0.00001);
    camera.far = Math.max(radius * 100, distance * 4);
    camera.updateProjectionMatrix();
    if (orbit) {
      orbit.target.copy(bounds.center);
      orbit.minDistance = radius * 0.005;
      orbit.maxDistance = Math.max(radius * 10, distance * 2);
      orbit.update();
    } else camera.lookAt(bounds.center);
  }, [bounds, camera, controls, resetToken, size.width, size.height]);
  return null;
}

const point = (node: Position): [number, number, number] => [node.x, node.y, node.z];
const finite = (node: Position) => [node.x, node.y, node.z].every(Number.isFinite);

function Overlays({ nodes, edges, route, showGraph, radius }: {
  nodes: ViewerNode[]; edges: ViewerEdge[]; route: ViewerNode[]; showGraph: boolean; radius: number;
}) {
  const byId = new Map(nodes.filter(finite).map((node) => [node.id, node]));
  const routePoints = route.every(finite) ? route.map(point) : [];
  const dotRadius = Math.max(radius * 0.006, 0.0001);
  return <>
    {showGraph && edges.map((edge) => {
      const from = byId.get(edge.fromNodeId), to = byId.get(edge.toNodeId);
      return from && to ? <Line key={edge.id} points={[point(from), point(to)]}
        color="#A9C4AE" lineWidth={1.5} depthTest={false} renderOrder={10} /> : null;
    })}
    {showGraph && [...byId.values()].map((node) => <mesh key={node.id} position={point(node)} renderOrder={11}>
      <sphereGeometry args={[dotRadius, 12, 8]} />
      <meshBasicMaterial color="#A9C4AE" depthTest={false} />
    </mesh>)}
    {routePoints.length > 1 && <Line points={routePoints} color="#F7B955" lineWidth={5}
      depthTest={false} renderOrder={20} />}
    {routePoints.length > 0 && [routePoints[0]!, routePoints[routePoints.length - 1]!].map((position, i) =>
      <mesh key={i} position={position} renderOrder={21}>
        <sphereGeometry args={[dotRadius * 1.8, 16, 12]} />
        <meshBasicMaterial color={i === 0 ? "#64D9B0" : "#F7B955"} depthTest={false} />
      </mesh>)}
  </>;
}

/**
 * Named places: a small marker on the spot the owner chose, and a label floating above it.
 * Labels keep a constant on-screen size so they stay readable when zoomed out.
 */
function PlacePins({ places, loaded, radius, highlightId, onSelect }: {
  places: ViewerPlace[]; loaded: LoadedModel[]; radius: number; highlightId?: string | null;
  onSelect: (place: ViewerPlace, world: Position) => void;
}) {
  const pins = useMemo(() => places.flatMap((place) => {
    const entry = loaded.find((candidate) => candidate.id === place.scanId) ?? (place.scanId ? undefined : loaded[0]);
    if (!entry || !finite(place.local)) return [];
    const world = entry.model.object.localToWorld(new Vector3(place.local.x, place.local.y, place.local.z));
    return [{ place, world: { x: world.x, y: world.y, z: world.z } }];
  }), [places, loaded]);
  const marker = Math.max(radius * 0.008, 0.06);
  const lift = Math.max(radius * 0.04, 0.6);
  return <>
    {pins.map(({ place, world }) => {
      const highlighted = place.id === highlightId;
      return <group key={place.id} position={point(world)}>
        <mesh renderOrder={30} raycast={() => {}}>
          <sphereGeometry args={[highlighted ? marker * 1.6 : marker, 16, 12]} />
          <meshBasicMaterial color={highlighted ? "#F7B955" : "#E8644A"} depthTest={false} />
        </mesh>
        <Line points={[[0, 0, 0], [0, lift, 0]]} color={highlighted ? "#F7B955" : "#E8644A"} lineWidth={2} depthTest={false} renderOrder={29} />
        {/* Below the page's own panels (z-10), so labels never cover the route controls. */}
        <Html position={[0, lift, 0]} center zIndexRange={[9, 1]}>
          <button type="button" onClick={() => onSelect(place, world)}
            aria-label={`${place.name}, ${place.categoryLabel}`}
            className={`pointer-events-auto whitespace-nowrap rounded-full px-3 py-1 text-sm font-bold shadow-lg ring-2 ${
              highlighted ? "bg-amber-300 text-night ring-amber-500" : "bg-paper text-night ring-rust/60"}`}>
            {place.name}
            <span className="ml-1 text-xs font-normal opacity-70">{place.categoryLabel}</span>
          </button>
        </Html>
      </group>;
    })}
  </>;
}

/**
 * Scan readability (lib/scan-surfaces.ts): hides ARKit ceiling faces and sharpens photo
 * textures at a slant. Geometry is untouched, so route finding is unaffected.
 */
function ScanLook({ objects, ceilingHidden, onCeiling }: {
  objects: Object3D[]; ceilingHidden: boolean; onCeiling: (hasCeiling: boolean) => void;
}) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const [surfaces, setSurfaces] = useState<ScanSurfaces | null>(null);
  useEffect(() => {
    const prepared = prepareScanSurfaces(objects, gl.capabilities.getMaxAnisotropy());
    setSurfaces(prepared);
    onCeiling(prepared.hasCeiling);
    return () => { prepared.dispose(); setSurfaces(null); };
  }, [objects, gl, onCeiling]);
  useEffect(() => { surfaces?.setCeilingHidden(ceilingHidden); invalidate(); }, [surfaces, ceilingHidden, invalidate]);
  return null;
}

class ViewerBoundary extends Component<{ children: ReactNode; onError?: (message: string) => void }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(error: Error) { this.props.onError?.(error.message); }
  render() {
    return this.state.error ? <p role="alert" className="p-6 text-paper">The 3D view could not start: {this.state.error}</p> : this.props.children;
  }
}

/** GLBs and overlays share one space frame. The parent owns authenticated downloads. */
export default function SpaceViewer({ models, nodes, edges, route = [], showGraph = false,
  resetToken = 0, onPick, onError, onReady, automaticNavigation = false, initialAutomaticNavigation = false, navigationApproximate = false, navigationUnavailable, avoidStairs = false, onAutomaticChange,
  places = [], highlightPlaceId, onPlaceSelect }: SpaceViewerProps) {
  const [automatic, setAutomatic] = useState(initialAutomaticNavigation);
  const [debug, setDebug] = useState(false);
  const [autoState, setAutoState] = useState<AutomaticState | null>(null);
  const enabled = automatic && automaticNavigation && !navigationUnavailable;
  useEffect(() => {
    onAutomaticChange?.(enabled);
    return () => onAutomaticChange?.(false);
  }, [enabled, onAutomaticChange]);
  const [loaded, setLoaded] = useState<LoadedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const callbacks = useRef({ onError, onReady });
  callbacks.current = { onError, onReady };
  useEffect(() => {
    let cancelled = false;
    const parsed: LoadedModel[] = [];
    setLoading(true); setError(null); setLoaded([]);
    void (async () => {
      try {
        for (const input of models) {
          const model = await parseGlb(input.bytes, input.transform);
          if (cancelled) { model.dispose(); return; }
          parsed.push({ id: input.id, model });
        }
        if (!cancelled) { setLoaded([...parsed]); setLoading(false); callbacks.current.onReady?.(); }
      } catch (cause) {
        if (cancelled) return;
        for (const entry of parsed.splice(0)) entry.model.dispose();
        const message = cause instanceof Error ? cause.message : "The GLB could not be read.";
        setError(message); setLoading(false); callbacks.current.onError?.(message);
      }
    })();
    return () => { cancelled = true; for (const entry of parsed) entry.model.dispose(); };
  }, [models]);
  const bounds = useMemo(() => {
    const box = new Box3();
    for (const entry of loaded) box.union(entry.model.bounds);
    if (box.isEmpty()) return new Sphere(new Vector3(), 1);
    const sphere = box.getBoundingSphere(new Sphere());
    sphere.radius = Math.max(sphere.radius, 0.001);
    return sphere;
  }, [loaded]);
  const objects = useMemo(() => loaded.map(entry => entry.model.object), [loaded]);
  const [hasCeiling, setHasCeiling] = useState(false);
  const [ceilingHidden, setCeilingHidden] = useState(true);
  function pick(event: ThreeEvent<MouseEvent>, entry: LoadedModel) {
    if (enabled) { event.stopPropagation(); autoState?.pick(event.point); return; }
    if (!onPick) return;
    event.stopPropagation();
    const local = entry.model.object.worldToLocal(event.point.clone());
    onPick({ scanId: entry.id, point: { x: event.point.x, y: event.point.y, z: event.point.z },
      localPoint: { x: local.x, y: local.y, z: local.z } });
  }
  if (error) return <p role="alert" className="p-6 text-paper">The model could not be opened: {error}</p>;
  if (loading) return <p role="status" className="p-6 text-paper">Building the 3D view…</p>;
  return <div className="relative h-full w-full"><ViewerBoundary onError={onError}>
    <Canvas flat dpr={[1, 2]} camera={{ fov: 55 }} gl={{ antialias: true, powerPreference: "high-performance" }}
      fallback={<p role="alert">This browser could not start WebGL. Try another browser or device.</p>}
      aria-label="Room model and navigation route. Drag to orbit; scroll or pinch to zoom.">
      <color attach="background" args={["#121C16"]} />
      {/* No tone curve (flat): the camera already captured the room's lighting, so a scan
          should show about 1x its colours. Floors get ~1.05x, walls ~0.85x: just enough
          shading to read depth. Unlit (photo-textured) scans ignore these lights. */}
      <ambientLight intensity={0.75} />
      <directionalLight position={[2, 10, 3]} intensity={0.35} />
      {loaded.map((entry) => <primitive key={entry.id} object={entry.model.object} dispose={null}
        onDoubleClick={(event: ThreeEvent<MouseEvent>) => pick(event, entry)} />)}
      <Overlays nodes={nodes} edges={edges} route={enabled ? (autoState?.points ?? []).map((p, i) => ({ ...p, id: `auto-${i}` })) : route} showGraph={!enabled && showGraph} radius={bounds.radius} />
      {enabled && debug && autoState?.navigation && <NavMeshOverlay navigation={autoState.navigation} />}
      {places.length > 0 && <PlacePins places={places} loaded={loaded} radius={bounds.radius} highlightId={highlightPlaceId}
        onSelect={(place, world) => { if (enabled) autoState?.pick(world); onPlaceSelect?.(place.id); }} />}
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} rotateSpeed={0.7} zoomSpeed={0.9}
        touches={{ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
        mouseButtons={{ LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }} />
      <Framing bounds={bounds} resetToken={resetToken} />
      <ScanLook objects={objects} ceilingHidden={ceilingHidden} onCeiling={setHasCeiling} />
    </Canvas>
  </ViewerBoundary>
    {(hasCeiling || automaticNavigation) && <div className="absolute left-3 top-24 z-10 flex w-[min(22rem,calc(100%-1.5rem))] flex-col items-start gap-2 xl-text:top-32">
      {automaticNavigation && <div className="max-h-[45vh] w-full overflow-auto rounded-xl bg-night/95 p-3 text-paper ring-1 ring-sage/50">
      <label className="flex gap-2"><input type="checkbox" checked={enabled} disabled={!!navigationUnavailable}
        onChange={e => { setAutomatic(e.target.checked); setAutoState(null); }} />Automatic route</label>
      {navigationUnavailable && <p className="text-sm">{navigationUnavailable}</p>}
      {enabled && !!objects.length && <Suspense fallback={<p role="status">Loading navigation…</p>}>
        <ScanNavigation key={models.map(m => m.id).join(",")} objects={objects} avoidStairs={avoidStairs} approximate={navigationApproximate} onChange={setAutoState} />
        <label className="mt-2 flex gap-2"><input type="checkbox" checked={debug} onChange={e => setDebug(e.target.checked)} />Show NavMesh debug</label>
      </Suspense>}
    </div>}
      {hasCeiling && <button type="button" aria-pressed={!ceilingHidden} onClick={() => setCeilingHidden(hidden => !hidden)}
        className="min-h-11 rounded-full bg-night/80 px-4 text-sm font-bold text-paper ring-1 ring-sage/50">
        {ceilingHidden ? "Show ceiling" : "Hide ceiling"}
      </button>}
    </div>}
  </div>;
}
