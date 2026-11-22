import { Html, Line, OrbitControls } from "@react-three/drei";
import { ChevronDown, ChevronUp, PersonStanding, X } from "lucide-react";
import { Canvas, useThree, type RootState, type ThreeEvent } from "@react-three/fiber";
import { Component, useCallback, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box3, DoubleSide, BufferGeometry, Float32BufferAttribute, MathUtils, MOUSE, PerspectiveCamera, Sphere, TOUCH, Vector2, Vector3, type Object3D } from "three";
import { encodeThumbnail, THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from "../lib/thumbnails";
import { bulkBox, fitDistance, overviewPose, samplePoints } from "../lib/framing";
import { parseGlb, type GlbModel } from "../lib/glb";
// lib/walk installs the fast (BVH) raycast before any scan is prepared; see that file.
import { accelerate } from "../lib/walk";
import { prepareScanSurfaces, type ScanSurfaces, type WallCut } from "../lib/scan-surfaces";
import Walker, { type WalkerHandle } from "./Walker";
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
  /** When set, renders one small dollhouse picture of the whole map (a JPEG) and hands it over. */
  onSnapshot?: (picture: Blob) => void;
}
interface LoadedModel { id: string; model: GlbModel }
interface OrbitLike { target: Vector3; minDistance: number; maxDistance: number; update(): void }

function Framing({ points, resetToken, paused }: { points: Vector3[]; resetToken: number; paused: boolean }) {
  const { camera, controls, size } = useThree();
  useEffect(() => {
    // While walking inside, the walker owns the camera (and restores the overview on exit).
    if (paused || !points.length) return;
    const orbit = controls as unknown as OrbitLike | null;
    const perspective = camera as PerspectiveCamera;
    // Frame the bulk of the scan, long side across the screen (lib/framing.ts).
    const pose = overviewPose(points, perspective.fov ?? 55, size.width / Math.max(size.height, 1));
    camera.position.copy(pose.position);
    camera.near = Math.max(pose.radius / 1000, 0.00001);
    camera.far = Math.max(pose.radius * 100, pose.distance * 4);
    camera.updateProjectionMatrix();
    if (orbit) {
      orbit.target.copy(pose.target);
      orbit.minDistance = pose.radius * 0.005;
      orbit.maxDistance = Math.max(pose.radius * 10, pose.distance * 2);
      orbit.update();
    } else camera.lookAt(pose.target);
    // `paused` is left out on purpose: leaving the walk restores the earlier overview, not a fresh one.
  }, [points, camera, controls, resetToken, size.width, size.height]);
  return null;
}

/**
 * Renders the map once from its own 5:3 dollhouse camera (the user's view is untouched),
 * into the corner of the drawing buffer, and copies that region into a JPEG. The next
 * frame redraws the normal view.
 */
function renderSnapshot(three: RootState, objects: Object3D[]): Promise<Blob | null> {
  const { gl, scene, invalidate } = three;
  const aspect = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
  const camera = new PerspectiveCamera(40, aspect);
  const points = samplePoints(objects);
  if (!points.length) return Promise.resolve(null);
  // Centre on the bulk of the scan, ignoring the outer 1% (stray depth points).
  const { center, size, radius } = bulkBox(points);
  // A steep, floor-plan-like look, from the side that lays the scan's long way across the
  // wide card; then move in until 98% of the points fit with a small margin.
  const direction = (size.z > size.x * 1.2 ? new Vector3(0.44, 0.9, 0) : new Vector3(0, 0.9, 0.44)).normalize();
  const place = (distance: number) => {
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(distance - radius * 3, radius / 1000, 0.00001);
    camera.far = distance + radius * 3;
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };
  place(fitDistance(points, center, direction, camera.fov, aspect));

  const buffer = gl.getDrawingBufferSize(new Vector2());
  let width = buffer.x, height = Math.round(width / aspect);
  if (height > buffer.y) { height = buffer.y; width = Math.round(height * aspect); }
  const ratio = gl.getPixelRatio(), css = gl.getSize(new Vector2());
  gl.setViewport(0, 0, width / ratio, height / ratio);
  gl.render(scene, camera);
  // WebGL's viewport starts bottom-left; the canvas image starts top-left.
  const encoded = encodeThumbnail(gl.domElement, 0, buffer.y - height, width, height);
  gl.setViewport(0, 0, css.x, css.y);
  invalidate();
  return encoded;
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
 * Scan readability (lib/scan-surfaces.ts): the wall cutaway and sharp photo textures at a
 * slant. Geometry is untouched, so route finding is unaffected.
 */
function ScanLook({ objects, cut, onCuts }: {
  objects: Object3D[]; cut: WallCut | null; onCuts: (cuts: WallCut[], defaultCut: WallCut) => void;
}) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const [surfaces, setSurfaces] = useState<ScanSurfaces | null>(null);
  useEffect(() => {
    const prepared = prepareScanSurfaces(objects, gl.capabilities.getMaxAnisotropy());
    setSurfaces(prepared);
    onCuts(prepared.cuts, prepared.defaultCut);
    invalidate();
    return () => { prepared.dispose(); setSurfaces(null); };
  }, [objects, gl, onCuts, invalidate]);
  useEffect(() => { if (surfaces && cut) { surfaces.setCut(cut); invalidate(); } }, [surfaces, cut, invalidate]);
  return null;
}

const CUT_LABELS: Record<WallCut, { label: string; hint: string }> = {
  low: { label: "Low walls", hint: "Walls cut at chest height, like a floor plan" },
  ceiling: { label: "No ceiling", hint: "Full-height walls, ceiling removed" },
  full: { label: "Everything", hint: "The whole scan, nothing cut" },
};

/** Three-way choice of how much of the walls to show. */
function WallCutChoice({ cuts, cut, onChange }: { cuts: WallCut[]; cut: WallCut; onChange: (cut: WallCut) => void }) {
  return <div role="group" aria-label="Wall height" className="flex rounded-full bg-night/85 p-1 text-paper ring-1 ring-sage/50 backdrop-blur-sm">
    {cuts.map((option) => <button key={option} type="button" aria-pressed={cut === option} title={CUT_LABELS[option].hint}
      onClick={() => onChange(option)}
      className={`min-h-9 rounded-full px-3 text-sm font-bold transition-colors ${cut === option ? "bg-paper text-ink" : "hover:bg-paper/10"}`}>
      {CUT_LABELS[option].label}
    </button>)}
  </div>;
}

const COARSE_POINTER = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

/**
 * The "walk inside" person. Drag it onto the model to stand there (like Street View), or
 * press it and then click or tap a spot. While dragging, a copy follows the pointer.
 */
function DropInButton({ armed, onArm, onDrop }: { armed: boolean; onArm: () => void; onDrop: (x: number, y: number) => void }) {
  const press = useRef<{ x: number; y: number; id: number } | null>(null);
  const dragged = useRef(false);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  return <>
    <button type="button" aria-pressed={armed}
      title="Drag onto the model to walk inside, or press and then pick a spot"
      onPointerDown={(event) => {
        press.current = { x: event.clientX, y: event.clientY, id: event.pointerId }; dragged.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!press.current || event.pointerId !== press.current.id) return;
        if (!dragged.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 6) dragged.current = true;
        if (dragged.current) setGhost({ x: event.clientX, y: event.clientY });
      }}
      onPointerUp={(event) => {
        if (!press.current || event.pointerId !== press.current.id) return;
        press.current = null; setGhost(null);
        if (dragged.current) onDrop(event.clientX, event.clientY);
      }}
      onPointerCancel={() => { press.current = null; setGhost(null); dragged.current = false; }}
      onClick={() => { if (dragged.current) { dragged.current = false; return; } onArm(); }}
      className={`flex min-h-11 touch-none select-none items-center gap-2 rounded-full px-4 text-sm font-bold shadow-lg ring-2 ${
        armed ? "bg-coral text-ink ring-coral" : "bg-paper text-ink ring-sage/60"}`}>
      <PersonStanding className="size-5" aria-hidden />Walk inside
    </button>
    {ghost && <span aria-hidden="true" style={{ left: ghost.x, top: ghost.y }}
      className="pointer-events-none fixed z-50 grid size-12 -translate-x-1/2 -translate-y-full place-items-center rounded-full bg-coral text-ink shadow-xl ring-2 ring-paper">
      <PersonStanding className="size-7" />
    </span>}
  </>;
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
  resetToken = 0, onPick, onError, onReady, onSnapshot, automaticNavigation = false, initialAutomaticNavigation = false, navigationApproximate = false, navigationUnavailable, avoidStairs = false, onAutomaticChange,
  places = [], highlightPlaceId, onPlaceSelect }: SpaceViewerProps) {
  const [automatic, setAutomatic] = useState(initialAutomaticNavigation);
  const [debug, setDebug] = useState(false);
  /** Minimised route card: only its status line shows, so the map stays visible. */
  const [routeFolded, setRouteFolded] = useState(false);
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
  const framePoints = useMemo(() => samplePoints(objects), [objects]);
  // Wall cutaway: the choices this scan supports, and the one shown (lib/scan-surfaces.ts).
  const [cuts, setCuts] = useState<WallCut[]>([]);
  const [cut, setCut] = useState<WallCut | null>(null);
  const onCuts = useCallback((options: WallCut[], start: WallCut) => { setCuts(options); setCut(start); }, []);
  // Walking inside ("drop in"): see components/Walker.tsx and lib/walk.ts.
  const walker = useRef<WalkerHandle>(null);
  const [walking, setWalking] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const cutBeforeWalk = useRef<WallCut | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flash = useCallback((message: string) => {
    setNotice(message); clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const enterWalk = useCallback(() => {
    setWalking(true); setPlacing(false); setNotice(null);
    setRouteFolded(true); // keep the view clear; the card's status line stays, one tap reopens it
    // Inside, show walls at full height; the overview's cut comes back on exit.
    setCut((current) => { cutBeforeWalk.current = current; return cuts.includes("full") ? "full" : current; });
  }, [cuts]);
  const exitWalk = useCallback(() => {
    setWalking(false); setPlacing(false);
    if (cutBeforeWalk.current) setCut(cutBeforeWalk.current);
    cutBeforeWalk.current = null;
  }, []);
  // Reset view always returns to the overview.
  useEffect(() => { setWalking(false); setPlacing(false); }, [resetToken]);
  useEffect(() => {
    if (!placing) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlacing(false);
      if (event.key === "Enter") {
        // Keyboard users drop in at the centre of the view.
        const canvas = document.querySelector<HTMLCanvasElement>("[data-space-viewer] canvas");
        const rect = canvas?.getBoundingClientRect();
        if (rect) walker.current?.dropAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [placing]);
  // Build the raycast index soon after the model appears, so clicks and dropping in are instant.
  useEffect(() => {
    if (!objects.length) return;
    const timer = setTimeout(() => accelerate(objects), 1200);
    return () => clearTimeout(timer);
  }, [objects]);
  const [three, setThree] = useState<RootState | null>(null);
  const snapshotCallback = useRef(onSnapshot);
  snapshotCallback.current = onSnapshot;
  const wantsSnapshot = !!onSnapshot;
  useEffect(() => {
    if (!wantsSnapshot || !three || !loaded.length) return;
    let cancelled = false;
    // Let the first frames compile shaders and hide ceilings before the picture.
    const timer = setTimeout(() => {
      void renderSnapshot(three, loaded.map((entry) => entry.model.object)).then((picture) => {
        if (picture && !cancelled) snapshotCallback.current?.(picture);
      });
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [wantsSnapshot, three, loaded]);
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
  return <div className="relative h-full w-full" data-space-viewer><ViewerBoundary onError={onError}>
    <Canvas flat dpr={[1, 2]} camera={{ fov: 55 }} gl={{ antialias: true, powerPreference: "high-performance" }}
      onCreated={setThree}
      fallback={<p role="alert">This browser could not start WebGL. Try another browser or device.</p>}
      aria-label={walking ? "Walking inside the model. Drag to look around; W, A, S, D or the arrow keys walk; Escape leaves." : "Room model and navigation route. Drag to move; right-drag or two fingers to turn; scroll or pinch to zoom."}>
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
      {/* Map-style overview: drag moves across the ground, right-drag or two fingers turn and tilt,
          the wheel zooms toward the cursor, arrow keys pan. Disabled while walking inside. */}
      <OrbitControls makeDefault enabled={!walking} enableDamping dampingFactor={0.08} rotateSpeed={0.7} zoomSpeed={1.1}
        zoomToCursor screenSpacePanning={false} maxPolarAngle={MathUtils.degToRad(88)} keyEvents
        touches={{ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE }}
        mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }} />
      <Walker handle={walker} objects={objects} active={walking} onEnter={enterWalk} onExit={exitWalk}
        onMiss={() => flash("No floor there. Try a spot on the floor.")} />
      <Framing points={framePoints} resetToken={resetToken} paused={walking} />
      <ScanLook objects={objects} cut={cut} onCuts={onCuts} />
    </Canvas>
  </ViewerBoundary>
    {placing && <div aria-hidden="true" className="absolute inset-0 z-[5] cursor-crosshair"
      onClick={(event) => walker.current?.dropAt(event.clientX, event.clientY)} />}
    {/* Phones: bottom right, above the hint and footer (the route card fills the top). Wider: top right. */}
    <div className="absolute right-3 bottom-36 z-10 flex max-w-[min(20rem,calc(100%-1.5rem))] flex-col items-end gap-2 sm:top-24 sm:bottom-auto xl-text:bottom-48 xl-text:sm:top-32 xl-text:sm:bottom-auto">
      {walking ? <>
        <button type="button" onClick={exitWalk}
          className="flex min-h-11 items-center gap-2 rounded-full bg-paper px-4 text-sm font-bold text-ink shadow-lg ring-2 ring-coral">
          <X className="size-5" aria-hidden />Back to overview
        </button>
        <p className="rounded-2xl bg-night/85 px-3 py-2 text-right text-sm text-paper ring-1 ring-sage/40 backdrop-blur-sm">
          {COARSE_POINTER() ? "Drag to look around · tap the floor to go there" : "Drag to look · W A S D or arrows to walk · Shift runs · click the floor to go there · Esc leaves"}
        </p>
      </> : <DropInButton armed={placing} onArm={() => { setPlacing((armed) => !armed); setNotice(null); }}
        onDrop={(x, y) => walker.current?.dropAt(x, y)} />}
      {placing && !walking && <p className="rounded-2xl bg-night/85 px-3 py-2 text-right text-sm text-paper ring-1 ring-sage/40">
        Click or tap the spot to stand on. Enter drops in at the centre · Esc cancels</p>}
      <p aria-live="polite" className={notice ? "rounded-2xl bg-rust px-3 py-2 text-sm font-bold text-paper" : "sr-only"}>{notice ?? ""}</p>
    </div>
    {(cuts.length > 0 || automaticNavigation) && <div className="absolute left-3 top-24 z-10 flex w-[min(19rem,calc(100%-1.5rem))] flex-col items-start gap-2 xl-text:top-32">
      {automaticNavigation && <div className="max-h-[50dvh] w-full overflow-auto rounded-2xl bg-night/90 px-3 py-2 text-paper shadow-lg ring-1 ring-sage/40 backdrop-blur-sm">
        <div className="flex min-h-11 items-center gap-2">
          <label className="flex flex-1 items-center gap-2 text-sm font-bold">
            <input type="checkbox" className="size-4 accent-coral" checked={enabled} disabled={!!navigationUnavailable}
              onChange={e => { setAutomatic(e.target.checked); setAutoState(null); }} />Automatic route
          </label>
          {enabled && <button type="button" aria-expanded={!routeFolded} aria-label={routeFolded ? "Show route controls" : "Minimise route controls"}
            onClick={() => setRouteFolded(folded => !folded)}
            className="-mr-2 grid size-11 shrink-0 place-items-center rounded-full text-sage hover:bg-paper/10">
            {routeFolded ? <ChevronDown className="size-5" aria-hidden /> : <ChevronUp className="size-5" aria-hidden />}
          </button>}
        </div>
        {navigationUnavailable && <p className="pb-1 text-sm">{navigationUnavailable}</p>}
        {enabled && !!objects.length && <Suspense fallback={<p role="status" className="text-sm">Loading navigation…</p>}>
          <div className="pb-1">
            <ScanNavigation key={models.map(m => m.id).join(",")} objects={objects} avoidStairs={avoidStairs}
              approximate={navigationApproximate} collapsed={routeFolded} onChange={setAutoState}>
              <label className="flex items-center gap-2 text-paper"><input type="checkbox" checked={debug} onChange={e => setDebug(e.target.checked)} />Show NavMesh debug</label>
            </ScanNavigation>
          </div>
        </Suspense>}
      </div>}
      {cuts.length > 0 && cut && <WallCutChoice cuts={cuts} cut={cut} onChange={setCut} />}
    </div>}
  </div>;
}
