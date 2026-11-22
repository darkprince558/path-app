import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3, type Object3D } from "three";
import { accelerate, EYE_HEIGHT, floorBelow, headingOf, lookDirection, standingPoint, step, WALL_GAP } from "../src/lib/walk.ts";

/** Floor at y=0 (20 x 20 m), a wall at x=3, and a 0.2 m step platform from z=-6 to -4. */
function room(): Object3D[] {
  const group = new Group();
  const box = (size: [number, number, number], at: [number, number, number]) => {
    const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial()); mesh.position.set(...at); group.add(mesh);
  };
  box([20, 0.2, 20], [0, -0.1, 0]);
  box([0.2, 3, 20], [3, 1.5, 0]);
  box([4, 0.2, 2], [0, 0.1, -5]);
  group.updateMatrixWorld(true);
  accelerate([group]);
  return [group];
}

test("finds the floor under a point and nothing over a hole", () => {
  const roots = room(), ray = new Raycaster();
  assert.ok(Math.abs(floorBelow(ray, roots, new Vector3(0, 0.3, 0))!.y) < 1e-6);
  assert.ok(Math.abs(floorBelow(ray, roots, new Vector3(0, 0.3, -5))!.y - 0.2) < 1e-6); // on the step
  assert.equal(floorBelow(ray, roots, new Vector3(50, 0, 50)), null);
});

test("walking stops before a wall and keeps eye height", () => {
  const roots = room(), ray = new Raycaster();
  const eye = new Vector3(0, EYE_HEIGHT, 0);
  const next = step(ray, roots, eye, new Vector3(5, 0, 0)); // the wall's face is at x=2.9
  assert.ok(Math.abs(next.x - (2.9 - WALL_GAP)) < 1e-3, `stopped at ${next.x}`);
  assert.ok(Math.abs(next.y - EYE_HEIGHT) < 1e-6);
  const free = step(ray, roots, eye, new Vector3(-1, 0, 0));
  assert.ok(Math.abs(free.x + 1) < 1e-6);
});

test("walking climbs a small step and follows the floor back down", () => {
  const roots = room(), ray = new Raycaster();
  let eye = new Vector3(0, EYE_HEIGHT, -2);
  eye = step(ray, roots, eye, new Vector3(0, 0, -3)); // onto the 0.2 m platform
  assert.ok(Math.abs(eye.y - (0.2 + EYE_HEIGHT)) < 1e-6, `eye ${eye.y}`);
  eye = step(ray, roots, eye, new Vector3(0, 0, 3));
  assert.ok(Math.abs(eye.y - EYE_HEIGHT) < 1e-6);
});

test("over a hole the height is kept, so gaps in a scan don't trap you", () => {
  const roots = room(), ray = new Raycaster();
  const next = step(ray, roots, new Vector3(9.5, EYE_HEIGHT, 0).setX(-9.5), new Vector3(-3, 0, 0)); // walks off the floor's edge
  assert.ok(Math.abs(next.y - EYE_HEIGHT) < 1e-6);
});

test("dropping on a wall stands you on the floor below it", () => {
  const roots = room(), ray = new Raycaster();
  ray.set(new Vector3(0, 1.5, 0), new Vector3(1, 0, 0));
  const hit = ray.intersectObjects(roots, true)[0]!;
  const stand = standingPoint(ray, roots, hit)!;
  assert.ok(Math.abs(stand.y) < 1e-6 && Math.abs(stand.x - 2.9) < 1e-3);
  const down = new Raycaster(new Vector3(1, 10, 1), new Vector3(0, -1, 0)); // helpers change near/far on `ray`
  const floorHit = down.intersectObjects(roots, true)[0]!;
  assert.ok(Math.abs(standingPoint(ray, roots, floorHit)!.y) < 1e-6);
});

test("heading and look direction agree", () => {
  for (const yaw of [0, 0.7, -2, 3]) {
    const direction = lookDirection(yaw, 0);
    assert.ok(Math.abs(Math.atan2(Math.sin(headingOf(direction) - yaw), Math.cos(headingOf(direction) - yaw))) < 1e-9);
  }
  assert.ok(lookDirection(0, 0).z < -0.99); // yaw 0 looks along -Z
  assert.ok(lookDirection(0, Math.PI / 2 - 1e-9).y > 0.99);
});
