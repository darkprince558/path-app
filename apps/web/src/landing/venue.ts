/**
 * The landing hero's scene. It follows the layout and coordinates of the synthetic
 * fixture (fixtures/venue/manifest.json): a T-shaped corridor in meters, +Y up,
 * entrance at the origin, −Z forward, workshop door on the left of the junction and
 * info booth on the right. The fixture itself has only 93 points, too few to read as
 * a place when they fly together, so the hero generates a denser cloud of the same
 * shape. Swap in a real scan later by building these arrays from its PLY.
 */

export type Vec3 = readonly [number, number, number];

export const WAYPOINTS = {
  entrance: [0, 0, 0],
  junction: [0, 0, -4],
  workshop: [-3, 0, -4],
  booth: [3, 0, -4],
} as const satisfies Record<string, Vec3>;

export type DestinationId = "workshop" | "booth";

export const DESTINATIONS: { id: DestinationId; label: string; door: string }[] = [
  { id: "workshop", label: "Workshop room", door: "amber" },
  { id: "booth", label: "Info booth", door: "purple" },
];

export function routeFor(destination: DestinationId): Vec3[] {
  return [WAYPOINTS.entrance, WAYPOINTS.junction, WAYPOINTS[destination]];
}

export interface VenueCloud {
  count: number;
  positions: Float32Array;
  colors: Float32Array;
  /** Where each point starts before the scan assembles. */
  starts: Float32Array;
  /** 0–1: when each point starts moving. Floors arrive first, then walls. */
  delays: Float32Array;
}

/** Small seeded generator so the scene looks the same on every visit. */
function seeded(seed: number) {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

export function buildVenueCloud(target = 14000): VenueCloud {
  const rand = seeded(11);
  const positions: number[] = [];
  const colors: number[] = [];
  const scale = target / 14000;
  const n = (count: number) => Math.max(1, Math.round(count * scale));

  const add = (x: number, y: number, z: number, rgb: Vec3, jitter = 26) => {
    positions.push(x, y, z);
    for (const channel of rgb) {
      const value = channel + (rand() - 0.5) * jitter;
      colors.push(Math.min(255, Math.max(0, value)) / 255);
    }
  };

  // Floor: tiles in two shades so the floor reads as a surface, not noise.
  const floor = (x: number, z: number) => {
    const tile = (Math.floor(x / 0.6) + Math.floor(z / 0.6)) & 1;
    add(x, 0, z, tile ? [150, 145, 130] : [128, 124, 112], 18);
  };
  for (let i = 0; i < n(3000); i++) floor(-1 + rand() * 2, 0.8 - rand() * 3.8);
  for (let i = 0; i < n(4200); i++) floor(-4.5 + rand() * 9, -3 - rand() * 2);

  const wallColor: Vec3 = [214, 206, 184];
  const isDoor = (x: number, y: number) => y < 2.1 && (Math.abs(x + 3) < 0.55 || Math.abs(x - 3) < 0.55);
  const wall = (count: number, place: (u: number) => [number, number], skipDoors = false) => {
    for (let i = 0; i < n(count); i++) {
      const [x, z] = place(rand());
      const y = rand() * 2.6;
      if (skipDoors && isDoor(x, y)) continue;
      // A darker band near the floor, like a skirting board.
      add(x, y, z, y < 0.12 ? [120, 110, 92] : wallColor);
    }
  };
  wall(900, (u) => [-1, 0.8 - u * 3.8]);
  wall(900, (u) => [1, 0.8 - u * 3.8]);
  wall(2000, (u) => [-4.5 + u * 9, -5], true);
  wall(700, (u) => [-4.5 + u * 3.5, -3]);
  wall(700, (u) => [1 + u * 3.5, -3]);
  wall(380, (u) => [-4.5, -3 - u * 2]);
  wall(380, (u) => [4.5, -3 - u * 2]);

  // Doors: amber for the workshop room, purple for the info booth, as in the fixture.
  const door = (centerX: number, rgb: Vec3) => {
    for (let i = 0; i < n(520); i++) add(centerX - 0.55 + rand() * 1.1, rand() * 2.1, -4.97, rgb, 34);
  };
  door(-3, [236, 172, 58]);
  door(3, [150, 100, 205]);

  // Green entrance mat.
  for (let i = 0; i < n(420); i++) add(-0.75 + rand() * 1.5, 0.012, 0.75 - rand() * 0.8, [70, 170, 108], 30);

  const count = positions.length / 3;
  const starts = new Float32Array(count * 3);
  const delays = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const b = (rand() - 0.5) * Math.PI;
    const r = 7 + rand() * 9;
    starts[i * 3] = Math.cos(a) * Math.cos(b) * r;
    starts[i * 3 + 1] = 1 + Math.sin(b) * r * 0.6;
    starts[i * 3 + 2] = -2.5 + Math.sin(a) * Math.cos(b) * r;
    const y = positions[i * 3 + 1] ?? 0;
    delays[i] = Math.min(1, rand() * 0.45 + (y / 2.6) * 0.3);
  }

  return {
    count,
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    starts,
    delays,
  };
}
