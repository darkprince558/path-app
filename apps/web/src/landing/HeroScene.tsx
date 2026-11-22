import { Html } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  AdditiveBlending,
  Color,
  CurvePath,
  DoubleSide,
  InstancedMesh,
  LineCurve3,
  MathUtils,
  Matrix4,
  Mesh,
  Object3D,
  Plane,
  QuadraticBezierCurve3,
  Raycaster,
  Shape,
  ShapeGeometry,
  ShaderMaterial,
  TubeGeometry,
  Vector3,
  type Group,
} from "three";
import { buildVenueCloud, routeFor, WAYPOINTS, type DestinationId, type Vec3 } from "./venue";

const NIGHT = "#121C16";
const CORAL = "#F48057";
const PAPER = new Color("#F3EBD0");
const NIGHT_COLOR = new Color(NIGHT);

/** Seconds: the cloud assembles, then the route draws. */
const ASSEMBLE = 2.2;
const ROUTE_DELAY = 2.0;
const ROUTE_DRAW = 2.8;
const LIFT = 0.035;

const easeOut = (x: number) => 1 - Math.pow(1 - MathUtils.clamp(x, 0, 1), 3);

/* ---------------------------------------------------------------- points */

const vertexShader = /* glsl */ `
  attribute vec3 aStart;
  attribute float aDelay;
  attribute vec3 aColor;
  uniform float uProgress;
  uniform float uScale;
  uniform vec3 uPointer;
  uniform float uGlow;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vGlow;
  void main() {
    float t = clamp((uProgress * 1.45 - aDelay) / 0.55, 0.0, 1.0);
    t = 1.0 - pow(1.0 - t, 3.0);
    vec3 p = mix(aStart, position, t);
    // Points near the cursor brighten and lift a little.
    float glow = uGlow * t * smoothstep(1.5, 0.0, distance(position.xz, uPointer.xz));
    p.y += glow * 0.14;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (0.05 + glow * 0.035) * uScale / -mv.z;
    vColor = aColor;
    vAlpha = 0.25 + 0.75 * t;
    vGlow = glow;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vGlow;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    vec3 color = mix(vColor, vec3(1.0, 0.72, 0.58), vGlow * 0.55) * (1.0 + vGlow * 0.35);
    gl_FragColor = vec4(color, vAlpha);
  }
`;

interface Timing {
  /** performance.now() when the cloud started assembling. */
  start: number;
  /** performance.now() when the current route started drawing. */
  route: number;
}

function Cloud({ timing, reduce, hovering }: { timing: Timing; reduce: boolean; hovering: RefObject<boolean> }) {
  const small = useThree((s) => s.size.width < 640);
  const cloud = useMemo(() => buildVenueCloud(small ? 9000 : 14000), [small]);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uProgress: { value: reduce ? 1 : 0 },
          uScale: { value: 600 },
          uPointer: { value: new Vector3(0, 0, -2) },
          uGlow: { value: 0 },
        },
      }),
    // Built once; reduce is read every frame instead.
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => () => material.dispose(), [material]);

  const raycaster = useMemo(() => new Raycaster(), []);
  const floor = useMemo(() => new Plane(new Vector3(0, 1, 0), 0), []);
  const hit = useMemo(() => new Vector3(), []);

  useFrame((state, delta) => {
    const u = material.uniforms;
    const elapsed = (performance.now() - timing.start) / 1000;
    u.uProgress!.value = reduce ? 1 : MathUtils.clamp(elapsed / ASSEMBLE, 0, 1);
    const camera = state.camera as typeof state.camera & { fov: number };
    u.uScale!.value = (state.size.height * state.viewport.dpr) / (2 * Math.tan(MathUtils.degToRad(camera.fov) / 2));
    const wantGlow = !reduce && hovering.current ? 1 : 0;
    u.uGlow!.value = MathUtils.damp(u.uGlow!.value as number, wantGlow, 6, delta);
    if (wantGlow) {
      raycaster.setFromCamera(state.pointer, state.camera);
      if (raycaster.ray.intersectPlane(floor, hit)) (u.uPointer!.value as Vector3).lerp(hit, 0.35);
    }
  });

  return (
    <points frustumCulled={false} material={material}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[cloud.positions, 3]} />
        <bufferAttribute attach="attributes-aStart" args={[cloud.starts, 3]} />
        <bufferAttribute attach="attributes-aDelay" args={[cloud.delays, 1]} />
        <bufferAttribute attach="attributes-aColor" args={[cloud.colors, 3]} />
      </bufferGeometry>
    </points>
  );
}

/* ----------------------------------------------------------------- route */

function curveFor(points: Vec3[]): CurvePath<Vector3> {
  const [a, corner, b] = points.map(([x, , z]) => new Vector3(x, LIFT, z)) as [Vector3, Vector3, Vector3];
  const path = new CurvePath<Vector3>();
  const r = 0.7;
  const before = corner.clone().add(a.clone().sub(corner).setLength(r));
  const after = corner.clone().add(b.clone().sub(corner).setLength(r));
  path.add(new LineCurve3(a, before));
  path.add(new QuadraticBezierCurve3(before, corner, after));
  path.add(new LineCurve3(after, b));
  return path;
}

const TUBE_SEGMENTS = 220;
const TUBE_RADIAL = 6;
const STRIDE = 0.4;

function footprintGeometry() {
  const sole = new Shape();
  sole.absellipse(0, 0.04, 0.042, 0.072, 0, Math.PI * 2, false, 0);
  const heel = new Shape();
  heel.absellipse(0, -0.085, 0.034, 0.04, 0, Math.PI * 2, false, 0);
  const geometry = new ShapeGeometry([sole, heel]);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function Route({
  destination,
  timing,
  reduce,
  onReadout,
}: {
  destination: DestinationId;
  timing: Timing;
  reduce: boolean;
  onReadout?: (text: string) => void;
}) {
  const { tube, glow, length, prints } = useMemo(() => {
    const curve = curveFor(routeFor(destination));
    const length = curve.getLength();
    const tube = new TubeGeometry(curve as never, TUBE_SEGMENTS, 0.04, TUBE_RADIAL, false);
    const glow = new TubeGeometry(curve as never, TUBE_SEGMENTS, 0.11, TUBE_RADIAL, false);
    const prints: { matrix: Matrix4; at: number }[] = [];
    const dummy = new Object3D();
    for (let d = 0.35, i = 0; d < length - 0.2; d += STRIDE, i++) {
      const u = d / length;
      const point = curve.getPointAt(u);
      const tangent = curve.getTangentAt(u);
      const side = i % 2 ? 1 : -1;
      dummy.position.set(point.x + tangent.z * side * 0.11, LIFT + 0.004, point.z - tangent.x * side * 0.11);
      dummy.rotation.set(0, Math.atan2(-tangent.x, -tangent.z), 0);
      dummy.updateMatrix();
      prints.push({ matrix: dummy.matrix.clone(), at: d });
    }
    return { tube, glow, length, prints };
  }, [destination]);
  useEffect(
    () => () => {
      tube.dispose();
      glow.dispose();
    },
    [tube, glow],
  );

  const printGeometry = useMemo(footprintGeometry, []);
  const printsRef = useRef<InstancedMesh>(null);
  const pinRef = useRef<Group>(null);
  const pulseRef = useRef<Mesh>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const color = useMemo(() => new Color(), []);
  const lastText = useRef("");

  useEffect(() => {
    const mesh = printsRef.current;
    if (!mesh) return;
    prints.forEach((print, i) => mesh.setMatrixAt(i, print.matrix));
    mesh.instanceMatrix.needsUpdate = true;
  }, [prints]);

  useFrame(() => {
    const now = performance.now();
    const raw = reduce ? 1 : MathUtils.clamp((now - timing.route) / 1000 / ROUTE_DRAW, 0, 1);
    const progress = easeOut(raw);
    const drawn = progress * length;
    const segments = Math.floor(progress * TUBE_SEGMENTS);
    tube.setDrawRange(0, segments * TUBE_RADIAL * 6);
    glow.setDrawRange(0, segments * TUBE_RADIAL * 6);

    const mesh = printsRef.current;
    if (mesh) {
      let visible = 0;
      for (const print of prints) {
        if (print.at > drawn - 0.15) break;
        // Older prints fade toward the floor, so the newest steps lead the eye.
        const age = reduce ? 0.3 : (drawn - print.at) / 3.5;
        color.copy(PAPER).lerp(NIGHT_COLOR, MathUtils.clamp(age, 0, 0.7));
        mesh.setColorAt(visible, color);
        visible++;
      }
      mesh.count = visible;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    const pinIn = reduce ? 1 : easeOut((raw - 0.82) / 0.18);
    if (pinRef.current) {
      pinRef.current.scale.setScalar(Math.max(0.0001, pinIn));
      pinRef.current.visible = pinIn > 0.001;
    }
    if (labelRef.current) labelRef.current.style.opacity = String(pinIn);

    if (pulseRef.current) {
      const phase = reduce ? 0.4 : ((now - timing.start) / 1400) % 1;
      pulseRef.current.scale.setScalar(1 + phase * 1.6);
      (pulseRef.current.material as { opacity: number }).opacity = (1 - phase) * 0.9;
    }

    if (onReadout) {
      const place = destination === "workshop" ? "workshop room" : "info booth";
      const text = raw < 1 ? `walking… ${drawn.toFixed(1)} / ${length.toFixed(1)} m` : `${place} · ${length.toFixed(1)} m from the entrance`;
      if (text !== lastText.current) {
        lastText.current = text;
        onReadout(text);
      }
    }
  });

  const end = WAYPOINTS[destination];
  const label = destination === "workshop" ? "Workshop room" : "Info booth";

  return (
    <group>
      <mesh geometry={glow}>
        <meshBasicMaterial color={CORAL} transparent opacity={0.22} depthWrite={false} blending={AdditiveBlending} />
      </mesh>
      <mesh geometry={tube}>
        <meshBasicMaterial color={CORAL} />
      </mesh>
      <instancedMesh ref={printsRef} args={[printGeometry, undefined, Math.max(1, prints.length)]} frustumCulled={false}>
        <meshBasicMaterial side={DoubleSide} transparent opacity={0.9} />
      </instancedMesh>
      {/* "You are here" pulse at the entrance */}
      <mesh ref={pulseRef} position={[0, LIFT, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.22, 0.29, 40]} />
        <meshBasicMaterial color="#78D296" transparent depthWrite={false} />
      </mesh>
      <group ref={pinRef} position={[end[0], 0, end[2]]}>
        <mesh position={[0, 0.55, 0]}>
          <cylinderGeometry args={[0.018, 0.018, 1.1, 8]} />
          <meshBasicMaterial color={CORAL} />
        </mesh>
        <mesh position={[0, 1.18, 0]}>
          <sphereGeometry args={[0.17, 24, 16]} />
          <meshBasicMaterial color={CORAL} />
        </mesh>
        <mesh position={[0, LIFT, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.16, 0.26, 40]} />
          <meshBasicMaterial color={CORAL} transparent opacity={0.6} />
        </mesh>
      </group>
      <Html position={[end[0], 1.55, end[2]]} center zIndexRange={[10, 0]} pointerEvents="none">
        <div
          ref={labelRef}
          aria-hidden="true"
          className="rounded-full bg-night/90 px-3 py-1 font-mono text-xs whitespace-nowrap text-paper ring-1 ring-coral"
          style={{ opacity: 0 }}
        >
          {label} · {length.toFixed(1)} m
        </div>
      </Html>
    </group>
  );
}

/* ---------------------------------------------------------------- camera */

/**
 * Camera framing by canvas shape. On a wide, full-bleed hero the camera looks a
 * little above the scan, so the scan sits low in the frame and rises from the
 * bottom edge. On a square phone frame it stands further back to fit the whole T.
 */
function framingFor(aspect: number) {
  if (aspect >= 1.6) return { target: new Vector3(0, 1.5, -2.4), distance: 9.2, pitch: 0.52 };
  if (aspect >= 1.1) return { target: new Vector3(0, 0.8, -2.4), distance: 8.6, pitch: 0.58 };
  return { target: new Vector3(0, 0.4, -2.3), distance: 12, pitch: 0.66 };
}

function Rig({ reduce, drag }: { reduce: boolean; drag: RefObject<{ yaw: number; pitch: number }> }) {
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / s.size.height);
  const framing = useMemo(() => framingFor(aspect), [aspect]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const { target, distance } = framing;
    const yaw = 0.62 + drag.current.yaw + (reduce ? 0 : Math.sin(t * 0.16) * 0.2);
    const pitch = MathUtils.clamp(framing.pitch + drag.current.pitch, 0.2, 1.2);
    camera.position.set(
      target.x + Math.sin(yaw) * Math.cos(pitch) * distance,
      target.y + Math.sin(pitch) * distance,
      target.z + Math.cos(yaw) * Math.cos(pitch) * distance,
    );
    camera.lookAt(target);
  });
  return null;
}

/* ----------------------------------------------------------------- scene */

export interface HeroSceneProps {
  destination: DestinationId;
  /** Change this number to replay the whole intro. */
  replayToken: number;
  reduceMotion: boolean;
  /** False while the hero is scrolled out of view, to stop drawing frames. */
  active: boolean;
  onReadout?: (text: string) => void;
}

export default function HeroScene({ destination, replayToken, reduceMotion, active, onReadout }: HeroSceneProps) {
  const timing = useRef<Timing>({ start: performance.now(), route: performance.now() + ROUTE_DELAY * 1000 }).current;
  const hovering = useRef(false);
  const drag = useRef({ yaw: 0, pitch: 0 });
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const firstDestination = useRef(true);

  useEffect(() => {
    const now = performance.now();
    timing.start = now;
    timing.route = now + ROUTE_DELAY * 1000;
  }, [replayToken, timing]);

  useEffect(() => {
    if (firstDestination.current) {
      firstDestination.current = false;
      return;
    }
    timing.route = performance.now();
  }, [destination, timing]);

  return (
    <div
      className="absolute inset-0"
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") hovering.current = true;
      }}
      onPointerLeave={() => {
        hovering.current = false;
      }}
      onPointerDown={(e) => {
        // Only a mouse turns the scene. On a phone, a finger on the hero scrolls the page.
        if (e.pointerType !== "mouse") return;
        pointer.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const p = pointer.current;
        if (!p || p.id !== e.pointerId) return;
        drag.current.yaw -= (e.clientX - p.x) * 0.006;
        drag.current.pitch = MathUtils.clamp(drag.current.pitch + (e.clientY - p.y) * 0.004, -0.35, 0.55);
        p.x = e.clientX;
        p.y = e.clientY;
      }}
      onPointerUp={() => {
        pointer.current = null;
      }}
      onPointerCancel={() => {
        pointer.current = null;
      }}
      style={{ cursor: "grab", touchAction: "pan-y" }}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ fov: 42, near: 0.1, far: 100 }}
        frameloop={active ? "always" : "never"}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        aria-hidden="true"
      >
        <fog attach="fog" args={[NIGHT, 14, 26]} />
        <Rig reduce={reduceMotion} drag={drag} />
        <Cloud timing={timing} reduce={reduceMotion} hovering={hovering} />
        <Route destination={destination} timing={timing} reduce={reduceMotion} onReadout={onReadout} />
      </Canvas>
    </div>
  );
}
