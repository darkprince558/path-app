import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { CanvasTexture, MathUtils, MOUSE, TOUCH, type Texture, type Vector3 } from "three";
import type { PointScan } from "../lib/ply";

const NIGHT = "#121C16";

/** The parts of drei's OrbitControls that framing touches. */
interface OrbitLike {
  target: Vector3;
  minDistance: number;
  maxDistance: number;
  update(): void;
}

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

export interface ScanViewerProps {
  scan: PointScan;
  /** Change this number to put the camera back to the starting view. */
  resetToken: number;
}

export default function ScanViewer({ scan, resetToken }: ScanViewerProps) {
  return (
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
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.7}
        zoomSpeed={0.9}
        maxPolarAngle={Math.PI * 0.92}
        touches={{ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
        mouseButtons={{ LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
      />
      <Framing scan={scan} resetToken={resetToken} />
    </Canvas>
  );
}
