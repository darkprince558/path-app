import { createContext, useContext, useEffect } from "react";
import { Canvas as GuestCanvas, useThree, type CanvasProps } from "@react-three/fiber";
import type { Vector3 } from "three";

export { useThree };

type GuestControls = {
  target: Vector3;
  enableDamping: boolean;
  minDistance: number;
  maxDistance: number;
  update(): void;
};

type Coordinates = [number, number, number];
export type CaptureView = {
  label: string;
  position: Coordinates;
  target: Coordinates;
  up: Coordinates;
};

export const CameraRequest = createContext<{ view?: CaptureView; revision: number }>({ revision: 0 });

function ApplyCaptureView({ request }: { request: React.ContextType<typeof CameraRequest> }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as GuestControls | null;
  useEffect(() => {
    if (!controls) return;
    const view = request.view;
    if (view) {
      // Discard any remaining damping from an earlier drag before setting the pose.
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = damping;
      camera.up.fromArray(view.up).normalize();
      camera.position.fromArray(view.position);
      controls.target.fromArray(view.target);
      const distance = camera.position.distanceTo(controls.target);
      controls.minDistance = Math.min(controls.minDistance, distance / 20);
      controls.maxDistance = Math.max(controls.maxDistance, distance * 2);
    } else {
      // The guest's Framing component restores the overview target and distance.
      camera.up.set(0, 1, 0);
    }
    controls.update();
  }, [camera, controls, request]);
  return null;
}

export function Canvas({ children, ...props }: CanvasProps) {
  const request = useContext(CameraRequest);
  return <GuestCanvas {...props}>{children}<ApplyCaptureView request={request} /></GuestCanvas>;
}
