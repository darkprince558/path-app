import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { CanvasTexture, MathUtils, MOUSE, Spherical, TOUCH, Vector3, type Texture } from "three";
import type { PointScan } from "../lib/ply";

const NIGHT = "#121C16";

/** The parts of drei's OrbitControls that framing touches. */
interface OrbitLike {
  target: Vector3;
  minDistance: number;
  maxDistance: number;
  maxPolarAngle: number;
  update(): void;
}

const MAX_POLAR = Math.PI * 0.92;

/** A soft round sprite so points read as dots rather than squares. */
function useDotTexture(): Texture {
  return useMemo(() => {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    }
    return new CanvasTexture(canvas);
  }, []);
}

/**
 * World-space point size from scan density: sparse scans (like the 93-point fixture)
 * get large dots so shapes stay readable, dense phone scans get fine ones.
 */
function pointSizeFor(scan: PointScan): number {
  const spacing = scan.bounds.radius / Math.sqrt(scan.count);
  return MathUtils.clamp(spacing * 0.7, 0.008, 0.3);
}

function Points({ scan }: { scan: PointScan }) {
  const dot = useDotTexture();
  const size = pointSizeFor(scan);
  useEffect(() => () => dot.dispose(), [dot]);
  return (
    <points geometry={scan.geometry} frustumCulled={false}>
      <pointsMaterial
        size={size}
        sizeAttenuation
        vertexColors={scan.hasColor}
        color={scan.hasColor ? "#ffffff" : "#A9C4AE"}
        map={dot}
        alphaTest={0.5}
        transparent={false}
      />
    </points>
  );
}

/**
 * Frames the scan from behind and above the entrance. The event frame puts the
 * entrance at the origin with −Z forward, so a camera on +Z looks down the corridor
 * the way a guest walking in would.
 */
function Framing({ scan, resetToken }: { scan: PointScan; resetToken: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;

  useEffect(() => {
    const { center, radius } = scan.bounds;
    // Fit the bounding sphere on narrow (portrait phone) screens too: use the
    // smaller of the vertical and horizontal fields of view.
    const perspective = camera as typeof camera & { fov?: number; aspect?: number };
    const vFov = MathUtils.degToRad(perspective.fov ?? 55);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (perspective.aspect ?? 1));
    const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 0.85;
    // About 24° above the floor, behind the entrance: low enough to read doorways as
    // standing shapes, high enough to see the corridor layout.
    camera.position.set(center.x, center.y + distance * 0.4, center.z + distance * 0.92);
    camera.near = Math.max(radius / 1000, 0.001);
    camera.far = radius * 50;
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(center);
      controls.minDistance = radius * 0.05;
      controls.maxDistance = radius * 6;
      controls.update();
    } else {
      camera.lookAt(center);
    }
  }, [scan, camera, controls, resetToken]);

  return null;
}

/**
 * Keyboard control for people who can't drag or pinch. While the map has focus:
 * arrow keys turn it (Shift for bigger steps), + and − zoom, R resets the view.
 */
function KeyboardOrbit({ target, onReset }: { target: RefObject<HTMLDivElement | null>; onReset: () => void }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;

  useEffect(() => {
    const element = target.current;
    if (!element || !controls) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        onReset();
        return;
      }
      const step = MathUtils.degToRad(event.shiftKey ? 30 : 10);
      const spherical = new Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      switch (event.key) {
        case "ArrowLeft":
          spherical.theta += step;
          break;
        case "ArrowRight":
          spherical.theta -= step;
          break;
        case "ArrowUp":
          spherical.phi -= step;
          break;
        case "ArrowDown":
          spherical.phi += step;
          break;
        case "+":
        case "=":
          spherical.radius *= 0.8;
          break;
        case "-":
        case "_":
          spherical.radius /= 0.8;
          break;
        default:
          return;
      }
      event.preventDefault();
      spherical.phi = MathUtils.clamp(spherical.phi, 0.05, controls.maxPolarAngle);
      spherical.radius = MathUtils.clamp(spherical.radius, controls.minDistance, controls.maxDistance);
      spherical.makeSafe();
      camera.position.copy(controls.target).add(new Vector3().setFromSpherical(spherical));
      camera.lookAt(controls.target);
      controls.update();
    };
    element.addEventListener("keydown", onKey);
    return () => element.removeEventListener("keydown", onKey);
  }, [target, camera, controls, onReset]);

  return null;
}

export interface ScanViewerProps {
  scan: PointScan;
  /** Change this number to put the camera back to the starting view. */
  resetToken: number;
  /** Turns off the glide after letting go (damping). */
  reduceMotion?: boolean;
  onReset: () => void;
}

export default function ScanViewer({ scan, resetToken, reduceMotion = false, onReset }: ScanViewerProps) {
  const keyTarget = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={keyTarget}
      tabIndex={0}
      role="application"
      aria-roledescription="3D map"
      aria-label="3D map. Arrow keys turn it, plus and minus zoom, R resets the view."
      className="group relative h-full w-full focus-visible:outline-3 focus-visible:-outline-offset-4 focus-visible:outline-(--focus-ring)"
    >
      <p
        aria-hidden="true"
        className="pointer-events-none absolute top-20 left-1/2 z-10 hidden -translate-x-1/2 rounded-full bg-night/90 px-3 py-1.5 text-sm whitespace-nowrap text-paper ring-1 ring-coral group-focus-visible:block"
      >
        ← → ↑ ↓ turn · + − zoom · R reset
      </p>
      <Canvas
        dpr={[1, 2]}
        camera={{ fov: 55 }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        aria-hidden="true"
      >
        <color attach="background" args={[NIGHT]} />
        <Points scan={scan} />
        <OrbitControls
          makeDefault
          enableDamping={!reduceMotion}
          dampingFactor={0.08}
          rotateSpeed={0.7}
          zoomSpeed={0.9}
          maxPolarAngle={MAX_POLAR}
          touches={{ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
          mouseButtons={{ LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
        />
        <Framing scan={scan} resetToken={resetToken} />
        <KeyboardOrbit target={keyTarget} onReset={onReset} />
      </Canvas>
    </div>
  );
}
