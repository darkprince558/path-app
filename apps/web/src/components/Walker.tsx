import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { PerspectiveCamera, Raycaster, Vector2, Vector3, type Object3D } from "three";
import { accelerate, EYE_HEIGHT, floorBelow, headingOf, lookDirection, RUN_SPEED, standingPoint, step, WALK_SPEED } from "../lib/walk";

/** What the page asks of the walker: drop in at a screen point, or leave. */
export interface WalkerHandle {
  /** Stands at the floor under this client (page) point. False when there is no floor there. */
  dropAt(clientX: number, clientY: number): boolean;
}

interface OrbitLike { target: Vector3; update(): void }
const UP = new Vector3(0, 1, 0);
const MAX_PITCH = (80 * Math.PI) / 180;
/** How far a click on the floor may glide you, in metres. */
const MAX_GLIDE = 80;
const GLIDE_SPEED = 8;
/** A press that moves less than this (px) and is released quickly is a click, not a look-drag. */
const CLICK_SLOP = 6;
const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * First-person walking inside the scan, Street View style. Mounted inside the Canvas.
 * Drag to look around, W/A/S/D or the arrow keys to walk (Shift runs), the scroll wheel to
 * step, a click or tap on the floor to glide there, Escape to leave. The eye stays
 * EYE_HEIGHT above the floor and stops short of walls (lib/walk.ts). Orbit controls are
 * disabled by the parent while walking; the overview camera is restored on exit.
 */
export default function Walker({ handle, objects, active, onEnter, onExit, onMiss }: {
  handle: Ref<WalkerHandle>;
  objects: Object3D[];
  active: boolean;
  onEnter: () => void;
  onExit: () => void;
  /** A drop or click found no floor. */
  onMiss: () => void;
}) {
  const { camera, gl, controls, size } = useThree();
  const raycaster = useRef(new Raycaster());
  const eye = useRef(new Vector3());
  const yaw = useRef(0), pitch = useRef(0);
  const keys = useRef(new Set<string>());
  const glide = useRef<Vector3 | null>(null);
  const saved = useRef<{ position: Vector3; target: Vector3 | null; near: number; far: number } | null>(null);
  const callbacks = useRef({ onEnter, onExit, onMiss });
  callbacks.current = { onEnter, onExit, onMiss };

  /** The first visible surface under a page point (hidden wall-cut faces are skipped by their raycast). */
  function surfaceAt(clientX: number, clientY: number) {
    const rect = gl.domElement.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.current.near = 0; raycaster.current.far = Infinity;
    raycaster.current.setFromCamera(ndc, camera);
    return raycaster.current.intersectObjects(objects, true)[0] ?? null;
  }

  useImperativeHandle(handle, () => ({
    dropAt(clientX, clientY) {
      accelerate(objects);
      const hit = surfaceAt(clientX, clientY);
      const stand = hit && standingPoint(raycaster.current, objects, hit);
      if (!stand) { callbacks.current.onMiss(); return false; }
      const orbit = controls as unknown as OrbitLike | null;
      const perspective = camera as PerspectiveCamera;
      saved.current = { position: camera.position.clone(), target: orbit?.target.clone() ?? null, near: perspective.near, far: perspective.far };
      // Face the way you were looking from above, levelled out.
      const facing = stand.clone().sub(camera.position).setY(0);
      yaw.current = facing.lengthSq() > 1e-6 ? headingOf(facing) : 0;
      pitch.current = 0;
      eye.current.copy(stand).y += EYE_HEIGHT;
      glide.current = null;
      perspective.near = 0.05; perspective.far = Math.max(perspective.far, 500); perspective.updateProjectionMatrix();
      callbacks.current.onEnter();
      return true;
    },
  }), [objects, camera, controls, gl]);

  // Leaving walk mode (Escape, the Exit button, Reset view): back to the saved overview.
  useEffect(() => {
    if (active || !saved.current) return;
    const perspective = camera as PerspectiveCamera;
    const orbit = controls as unknown as OrbitLike | null;
    camera.position.copy(saved.current.position);
    perspective.near = saved.current.near; perspective.far = saved.current.far; perspective.updateProjectionMatrix();
    if (orbit && saved.current.target) { orbit.target.copy(saved.current.target); orbit.update(); }
    saved.current = null;
    keys.current.clear();
  }, [active, camera, controls]);

  // Look by dragging, glide by clicking, step with the wheel, walk with the keyboard.
  useEffect(() => {
    if (!active) return;
    const element = gl.domElement;
    let press: { x: number; y: number; at: number; id: number } | null = null;
    let last = { x: 0, y: 0 };
    let pendingGlide: ReturnType<typeof setTimeout> | undefined;
    const lookSpeed = (Math.PI * 0.9) / Math.max(size.width, 1); // a full-width drag turns ~160°

    function down(event: PointerEvent) {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      press = { x: event.clientX, y: event.clientY, at: performance.now(), id: event.pointerId };
      last = { x: event.clientX, y: event.clientY };
      element.setPointerCapture(event.pointerId);
    }
    function move(event: PointerEvent) {
      if (!press || event.pointerId !== press.id) return;
      // "Grab the world": dragging right turns the view left, like Street View.
      yaw.current += (event.clientX - last.x) * lookSpeed;
      pitch.current = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch.current + (event.clientY - last.y) * lookSpeed));
      last = { x: event.clientX, y: event.clientY };
    }
    function up(event: PointerEvent) {
      if (!press || event.pointerId !== press.id) return;
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
      const quick = performance.now() - press.at < 400;
      press = null;
      if (moved > CLICK_SLOP || !quick) return;
      const { clientX, clientY } = event;
      // Wait a moment so a double-click (route start/destination) doesn't also move you.
      clearTimeout(pendingGlide);
      pendingGlide = setTimeout(() => {
        const hit = surfaceAt(clientX, clientY);
        const stand = hit && standingPoint(raycaster.current, objects, hit);
        if (!stand || stand.distanceTo(eye.current) > MAX_GLIDE) { callbacks.current.onMiss(); return; }
        glide.current = stand.add(new Vector3(0, EYE_HEIGHT, 0));
      }, 260);
    }
    function doubleClick() { clearTimeout(pendingGlide); }
    function wheel(event: WheelEvent) {
      event.preventDefault();
      const forward = lookDirection(yaw.current, 0).multiplyScalar(-Math.sign(event.deltaY) * 0.75);
      eye.current.copy(step(raycaster.current, objects, eye.current, forward));
      glide.current = null;
    }
    function keyDown(event: KeyboardEvent) {
      if (TYPING.has((event.target as HTMLElement | null)?.tagName ?? "")) return;
      if (event.key === "Escape") { callbacks.current.onExit(); return; }
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "q", "e"].includes(key)) {
        keys.current.add(key); glide.current = null; event.preventDefault();
      }
      if (key === "Shift") keys.current.add("Shift");
    }
    function keyUp(event: KeyboardEvent) {
      keys.current.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key);
    }
    function blur() { keys.current.clear(); }
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    element.addEventListener("dblclick", doubleClick);
    element.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      clearTimeout(pendingGlide);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.removeEventListener("dblclick", doubleClick);
      element.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  }, [active, gl, objects, size.width]);

  useFrame((_, delta) => {
    if (!active) return;
    const dt = Math.min(delta, 0.1);
    const held = keys.current;
    if (held.has("ArrowLeft") || held.has("q")) yaw.current += 1.8 * dt;
    if (held.has("ArrowRight") || held.has("e")) yaw.current -= 1.8 * dt;
    const forward = lookDirection(yaw.current, 0);
    const right = forward.clone().cross(UP);
    const move = new Vector3();
    if (held.has("w") || held.has("ArrowUp")) move.add(forward);
    if (held.has("s") || held.has("ArrowDown")) move.sub(forward);
    if (held.has("d")) move.add(right);
    if (held.has("a")) move.sub(right);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar((held.has("Shift") ? RUN_SPEED : WALK_SPEED) * dt);
      eye.current.copy(step(raycaster.current, objects, eye.current, move));
    } else if (glide.current) {
      // Glide straight to a clicked floor point (you saw it, so nothing blocks the way).
      const toward = glide.current.clone().sub(eye.current);
      const distance = toward.length();
      const travel = Math.min(distance, Math.max(GLIDE_SPEED, distance * 2.5) * dt);
      eye.current.addScaledVector(toward.divideScalar(Math.max(distance, 1e-6)), travel);
      if (distance - travel < 0.02) {
        eye.current.copy(glide.current); glide.current = null;
        const floor = floorBelow(raycaster.current, objects, eye.current.clone().setY(eye.current.y - EYE_HEIGHT));
        if (floor) eye.current.y = floor.y + EYE_HEIGHT;
      }
    }
    camera.position.copy(eye.current);
    camera.lookAt(eye.current.clone().add(lookDirection(yaw.current, pitch.current)));
  });

  return null;
}
