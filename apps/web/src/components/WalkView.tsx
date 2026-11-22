import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Map as MapIcon } from "lucide-react";
import type { FloorPosition, NavigationMesh, Point } from "../lib/navmesh";

export interface WalkWaypoint { id: string; name: string; point: Point; yaw?: number }
export interface WalkSession {
  navigation: NavigationMesh;
  floor: FloorPosition;
  yaw: number;
  pitch: number;
  keys: Set<string>;
}

/** Prefer a clear forward view when the map does not supply a landmark heading. */
export function startWalking(navigation: NavigationMesh, floor: FloorPosition, heading?: number): WalkSession {
  let yaw = heading ?? 0;
  if (heading === undefined) {
    let best = -1;
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6;
      let probe = floor;
      for (let j = 0; j < 20; j++) probe = navigation.step(probe, -0.2 * Math.sin(angle), -0.2 * Math.cos(angle));
      const distance = Math.hypot(probe.point.x - floor.point.x, probe.point.z - floor.point.z);
      if (distance > best) { best = distance; yaw = angle; }
    }
  }
  return { navigation, floor, yaw, pitch: 0, keys: new Set() };
}

const movement: Record<string, string> = {
  KeyW: "forward", ArrowUp: "forward", KeyS: "back", ArrowDown: "back",
  KeyA: "left", KeyD: "right", ArrowLeft: "turnLeft", ArrowRight: "turnRight",
};

export function WalkCamera({ walk, onExit }: { walk: WalkSession; onExit: () => void }) {
  const { camera, gl, invalidate } = useThree();
  useLayoutEffect(() => {
    const canvas = gl.domElement;
    const previous = canvas.getAttribute("tabindex");
    const near = camera.near;
    canvas.tabIndex = 0;
    canvas.focus({ preventScroll: true });
    camera.near = 0.045;
    camera.updateProjectionMatrix();
    invalidate();
    let drag: { id: number; x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      if (drag || event.button !== 0) return;
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const move = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      walk.yaw -= (e.clientX - drag.x) * 0.005;
      walk.pitch = Math.max(-1.25, Math.min(1.25, walk.pitch - (e.clientY - drag.y) * 0.005));
      drag.x = e.clientX; drag.y = e.clientY; invalidate();
    };
    const up = (e: PointerEvent) => { if (drag?.id === e.pointerId) drag = null; };
    const press = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Escape") { e.preventDefault(); onExit(); return; }
      if (movement[e.code]) { e.preventDefault(); walk.keys.add(e.code); invalidate(); }
    };
    const release = (e: KeyboardEvent) => { walk.keys.delete(e.code); };
    const clear = () => walk.keys.clear();
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("lostpointercapture", up);
    canvas.addEventListener("keydown", press);
    canvas.addEventListener("blur", clear);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", clear);
    return () => {
      clear(); camera.near = near; camera.updateProjectionMatrix();
      if (previous === null) canvas.removeAttribute("tabindex"); else canvas.setAttribute("tabindex", previous);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("lostpointercapture", up);
      canvas.removeEventListener("keydown", press);
      canvas.removeEventListener("blur", clear);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", clear);
    };
  }, [camera, gl, invalidate, walk, onExit]);

  useFrame((state, delta) => {
    if (walk.keys.size) state.invalidate();
    const dt = Math.min(0.075, delta);
    const held = (code: string) => Number(walk.keys.has(code));
    walk.yaw += (held("ArrowLeft") - held("ArrowRight")) * dt * 1.7;
    const forward = Math.max(held("KeyW"), held("ArrowUp")) - Math.max(held("KeyS"), held("ArrowDown"));
    const side = held("KeyD") - held("KeyA");
    if (forward || side) {
      const length = dt * 1.7 / Math.hypot(forward, side);
      const sin = Math.sin(walk.yaw), cos = Math.cos(walk.yaw);
      walk.floor = walk.navigation.step(walk.floor, (side * cos - forward * sin) * length, (-forward * cos - side * sin) * length);
    }
    const { x, y, z } = walk.floor.point;
    camera.position.set(x, y + 1.6, z);
    camera.rotation.set(walk.pitch, walk.yaw, 0, "YXZ");
  });
  return null;
}

const pad = [
  ["KeyW", "Move forward", ArrowUp, "col-start-2"], ["KeyA", "Move left", ArrowLeft, "col-start-1"],
  ["KeyS", "Move backward", ArrowDown, ""], ["KeyD", "Move right", ArrowRight, ""],
] as const;

export function WalkPanel({ walk, waypoints, exit, onRoute, invalidate }: {
  invalidate: () => void; walk: WalkSession; waypoints: WalkWaypoint[]; exit: () => void; onRoute: (points: Point[]) => void;
}) {
  const [message, setMessage] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const destination = waypoints.find(p => p.id === destinationId);
  useEffect(() => {
    if (!destination) { onRoute([]); setMessage(""); return; }
    let last: Point | undefined;
    const refresh = () => {
      const current = walk.floor.point;
      if (last && Math.hypot(current.x - last.x, current.y - last.y, current.z - last.z) < .65) return;
      last = { ...current };
      const result = walk.navigation.route(current, destination.point);
      onRoute(result.ok ? result.points : []);
      setMessage(!result.ok ? `No connected floor route to ${destination.name}.`
        : result.distance < .9 ? `Arrived at ${destination.name}` : `${destination.name} · ${Math.round(result.distance)} m from here`);
    };
    refresh();
    const timer = window.setInterval(refresh, 350);
    return () => window.clearInterval(timer);
  }, [walk, destination, onRoute]);
  const activePointers = useRef(new Set<string>());
  useEffect(() => {
    const keys = activePointers.current;
    return () => { for (const key of keys) walk.keys.delete(key); keys.clear(); };
  }, [walk]);
  const buttonClass = "grid size-11 touch-none select-none place-items-center rounded-full bg-night/90 text-paper shadow ring-1 ring-sage/50 active:bg-coral";
  return <>
    <div className="absolute top-24 left-3 z-10 max-w-[min(20rem,calc(100%-1.5rem))] space-y-1 rounded-xl bg-night/90 p-2 text-sm text-paper">
      <button type="button" onClick={exit} className="inline-flex min-h-10 items-center gap-2 rounded-lg px-2 font-bold"><MapIcon size={18}/>Map view</button>
      {waypoints.length > 0 && <select aria-label="Directions to waypoint" value={destinationId} className="max-w-full rounded bg-night p-2"
        onChange={e => { setDestinationId(e.target.value); e.currentTarget.closest("[data-scan-viewer]")?.querySelector("canvas")?.focus(); }}>
        <option value="">Directions to…</option>
        {waypoints.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>}
      <p className="px-2 text-xs text-sage">Drag to look · WASD to walk</p>
      {message && <p role="status" className="px-2">{message}</p>}
    </div>
    <div aria-label="Walking controls" className="absolute bottom-24 right-3 z-10 grid grid-cols-3 gap-1">
      {pad.map(([code, name, Icon, col]) => <button type="button" key={code} aria-label={name} className={buttonClass + " " + col}
        onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); activePointers.current.add(code); walk.keys.add(code); invalidate(); }}
        onLostPointerCapture={() => { activePointers.current.delete(code); walk.keys.delete(code); }}
        onClick={e => {
          if (e.detail !== 0) return;
          invalidate();
          const lateral = code === "KeyD" ? 1 : code === "KeyA" ? -1 : 0;
          const forward = code === "KeyW" ? 1 : code === "KeyS" ? -1 : 0;
          walk.floor = walk.navigation.step(walk.floor, .2 * (lateral * Math.cos(walk.yaw) - forward * Math.sin(walk.yaw)), .2 * (-forward * Math.cos(walk.yaw) - lateral * Math.sin(walk.yaw)));
        }}><Icon size={20}/></button>)}
    </div>
  </>;
}
