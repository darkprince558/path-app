import assert from "node:assert/strict";
import { test } from "node:test";
import { Group } from "three";
import { buildNavMesh, DEFAULT_AGENT, trianglesFromObject } from "../src/lib/navmesh.ts";
import { createRoom, disposeRoom } from "../src/lib/navmesh-room.ts";

const start = { x: -4, y: 0, z: -2 }, end = { x: 4, y: 0, z: -2 };
async function roomTest(options, agent, run) {
  const room = createRoom(options);
  const nav = await buildNavMesh(trianglesFromObject(room), { ...DEFAULT_AGENT, ...agent });
  try { run(nav); } finally { nav.dispose(); nav.dispose(); disposeRoom(room); }
}

test("concurrent first builds share WASM initialization and remain independently usable", async () => {
  const room = createRoom();
  const meshes = await Promise.all(Array.from({ length: 3 }, () => buildNavMesh(trianglesFromObject(room))));
  try {
    meshes[0].dispose();
    for (const nav of meshes.slice(1)) assert.equal(nav.route(start, end).ok, true);
  } finally { for (const nav of meshes) nav.dispose(); disposeRoom(room); }
});

test("triangle-derived route avoids wall and obstacle and crosses only the doorway", async () => {
  await roomTest({}, {}, nav => {
    assert.ok(nav.debug.indices.length > 0);
    const route = nav.route(start, end);
    assert.equal(route.ok, true);
    assert.ok(route.distance > 10 && route.distance < 13);
    assert.ok(route.points.length > 2);
    let crossed = false;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1], b = route.points[i];
      if (a.x * b.x <= 0 && a.x !== b.x) {
        const z = a.z + (b.z - a.z) * (-a.x / (b.x - a.x));
        assert.ok(z >= 1.3 && z <= 2.7, `wall crossed outside doorway at z=${z}`);
        crossed = true;
      }
      for (let t = 0; t <= 1; t += 0.01) {
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const dx = Math.max(-2.9 - x, 0, x + 1.9), dz = Math.max(-0.1 - z, 0, z - 1.1);
        assert.ok(Math.hypot(dx, dz) >= 0.29, "route enters circular agent obstacle clearance");
      }
    }
    assert.ok(crossed);
    assert.equal(nav.route({ x: -3.1, y: 0, z: 3.2 }, { x: 4.2, y: 0, z: 3.5 }).ok, true);
    nav.dispose();
    assert.equal(nav.route(start, end).ok, false);
  });
});

test("closed doorway and excessive radius/headroom yield no complete route", async () => {
  for (const [options, agent] of [[{ closed: true }, {}], [{}, { radius: 1.1 }], [{}, { height: 2.7 }]]) {
    await roomTest(options, agent, nav => {
      const route = nav.route(start, end);
      assert.equal(route.ok, false);
      assert.match(route.message, /No complete route/);
      assert.equal(nav.route(start, { x: -4, y: 0, z: 3 }).ok, true);
    });
  }
});

test("step clearance blocks a threshold until the configured climb allows it", async () => {
  await roomTest({ threshold: 0.4 }, { step: 0.15 }, nav => assert.equal(nav.route(start, end).ok, false));
  await roomTest({ threshold: 0.4 }, { step: 0.5 }, nav => assert.equal(nav.route(start, end).ok, true));
});

test("slope limit filters a continuous 30 degree ramp", async () => {
  const h = 4 * Math.tan(Math.PI / 6);
  const input = { positions: [-4, 0, -2, 0, 0, -2, 0, 0, 2, -4, 0, 2, 4, h, -2, 4, h, 2],
    indices: [0, 2, 1, 0, 3, 2, 1, 5, 4, 1, 2, 5] };
  for (const slope of [20, 40]) {
    const nav = await buildNavMesh(input, { ...DEFAULT_AGENT, slope });
    try { assert.equal(nav.route({ x: -2, y: 0, z: 0 }, { x: 3, y: h * 0.75, z: 0 }).ok, slope === 40); }
    finally { nav.dispose(); }
  }
});

test("invalid, outside, obstructed and vertically distant endpoints cannot snap across barriers", async () => {
  await roomTest({}, {}, nav => {
    for (const p of [{ x: NaN, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: -2 },
      { x: -2.4, y: 0, z: 0.5 }, { x: -4, y: 1, z: -2 }]) {
      assert.equal(nav.route(p, end).ok, false);
    }
    const same = nav.route(start, start);
    assert.equal(same.ok, true); assert.equal(same.distance, 0);
  });
});

test("reject invalid/degenerate/oversized triangles and invalid agent settings before WASM", async () => {
  const valid = trianglesFromObject(createRoom());
  for (const input of [{ positions: [], indices: [] }, { ...valid, indices: [0, 1] },
    { ...valid, indices: [0, 1, 99999] }, { ...valid, indices: [0, 0, 0] },
    { ...valid, positions: valid.positions.map((v, i) => i === 0 ? Infinity : v) },
    { positions: [0, 0, 0, 1e6, 0, 0, 0, 0, 1e6], indices: [0, 2, 1] }]) {
    await assert.rejects(buildNavMesh(input), /geometry|Geometry|triangles/);
  }
  await assert.rejects(buildNavMesh(valid, { ...DEFAULT_AGENT, radius: -1 }), /Invalid agent/);
  // All triangles face down: no walkability, rather than a fabricated route.
  await assert.rejects(buildNavMesh({ positions: [-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2], indices: [0, 1, 2, 0, 2, 3] }), /failed|walkable/);
});

test("extraction preserves hierarchy, scan transform and winding under reflection", async () => {
  const room = createRoom(), parent = new Group();
  parent.position.set(20, 3, 7); parent.scale.set(-1, 1, 1); parent.add(room);
  const nav = await buildNavMesh(trianglesFromObject(parent));
  try {
    const transform = p => ({ x: 20 - p.x, y: p.y + 3, z: p.z + 7 });
    const route = nav.route(transform(start), transform(end));
    assert.equal(route.ok, true); assert.ok(route.distance > 10);
  } finally { nav.dispose(); disposeRoom(room); }
});
