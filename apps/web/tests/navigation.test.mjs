import assert from "node:assert/strict";
import { test } from "node:test";
import { Vector3 } from "three";
import { findRoute, savedRoute } from "../src/lib/navigation.ts";
import { alignmentMatrix, alignmentControls, calibrationScale } from "../src/lib/alignment.ts";
import { Matrix4 } from "three";

const node = (id, x, z = 0) => ({ id, spaceId: "room", x, y: 0, z });
const edge = (fromNodeId, toNodeId, distance, bidirectional = false) => ({
  id: `${fromNodeId}-${toNodeId}`, spaceId: "room", fromNodeId, toNodeId, distance, bidirectional, accessible: true,
});
const graph = {
  spaceId: "room", nodes: [node("a", 0), node("b", 10), node("c", 20), node("isolated", 30)],
  // Geometric distance is not an admissible heuristic for these legacy costs.
  edges: [edge("a", "c", 5), edge("a", "b", 1), edge("b", "c", 1)], destinations: [],
};

test("A* selects cheapest directed route even with costs below geometric distance", () => {
  const route = findRoute(graph, "a", "c");
  assert.deepEqual(route.nodes.map(n => n.id), ["a", "b", "c"]);
  assert.equal(route.distance, 2);
  assert.equal(findRoute(graph, "c", "a"), null);
  assert.equal(findRoute(graph, "a", "isolated"), null);
  assert.equal(findRoute(graph, "a", "a").distance, 0);
});

test("routes honor bidirectional connections and reject endpoints or graph data outside space", () => {
  assert.deepEqual(findRoute({ ...graph, edges: [edge("a", "b", 1, true)] }, "b", "a").nodes.map(n => n.id), ["b", "a"]);
  assert.throws(() => findRoute(graph, "foreign", "a"));
  assert.throws(() => findRoute({ ...graph, nodes: [...graph.nodes, { ...node("foreign", 0), spaceId: "other" }] }, "a", "c"));
  assert.throws(() => findRoute({ ...graph, edges: [edge("a", "b", NaN)] }, "a", "b"));
  assert.throws(() => findRoute({ ...graph, destinations: [{ id: "bad", spaceId: "room", nodeId: "foreign" }] }, "a", "b"));
});

test("saved route uses current graph coordinates and validates each allowed edge", () => {
  const path = { spaceId: "room", waypoints: [{ nodeId: "a", sequence: 0, x: 999 }, { nodeId: "b", sequence: 1 }] };
  assert.equal(savedRoute(graph, path).nodes[0].x, 0);
  assert.throws(() => savedRoute(graph, { ...path, spaceId: "other" }));
  assert.throws(() => savedRoute(graph, { ...path, waypoints: [{ nodeId: "b", sequence: 0 }, { nodeId: "a", sequence: 1 }] }));
  assert.throws(() => savedRoute(graph, { ...path, waypoints: [{ nodeId: "a", sequence: 0 }, { nodeId: "b", sequence: 2 }] }));
});

test("alignment applies S then Rx Ry Rz then T and remains column-major", () => {
  const values = alignmentMatrix(2, { x: 0, y: 90, z: 0 }, { x: 3, y: 0, z: -2 });
  const p = new Vector3(1, 0, 0).applyMatrix4(new Matrix4().fromArray(values));
  assert.ok(p.distanceTo(new Vector3(3, 0, -4)) < 1e-10);
  assert.deepEqual(values.slice(12, 15), [3, 0, -2]);
  assert.equal(calibrationScale({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, 5), 2.5);
  assert.throws(() => calibrationScale({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 5));
});

test("restoring saved alignment preserves rotation and translation during recalibration", () => {
  const input = alignmentMatrix(2.5, { x: 12, y: -37, z: 24 }, { x: 3, y: 2, z: -2 });
  const controls = alignmentControls(input);
  const output = alignmentMatrix(controls.scale, controls.rotation, controls.translation);
  output.forEach((value, i) => assert.ok(Math.abs(value - input[i]) < 1e-10));
  const calibrated = alignmentMatrix(4, controls.rotation, controls.translation);
  assert.deepEqual(calibrated.slice(12, 15), input.slice(12, 15));
  const nonuniform = new Matrix4().makeScale(1, 2, 1).toArray();
  assert.equal(alignmentControls(nonuniform), null);
});
