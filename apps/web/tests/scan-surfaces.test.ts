import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Mesh, Raycaster, Vector3, type Intersection } from "three";
import { parseGlb } from "../src/lib/glb.ts";
import { prepareScanSurfaces } from "../src/lib/scan-surfaces.ts";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// A 6 x 4 x 2.5 m room shaped like Path Capture's export (tools/make_classified_room.py).
const room = () => {
  const bytes = readFileSync(new URL("../../../fixtures/venue/classified-room.glb", import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

function firstMesh(root: { traverse(cb: (o: unknown) => void): void }) {
  let mesh: Mesh | undefined;
  root.traverse((object) => { if (!mesh && object instanceof Mesh) mesh = object; });
  return mesh!;
}

test("scan ceilings are hidden for clicks and can be shown again", async () => {
  const model = await parseGlb(room(), identity);
  const surfaces = prepareScanSurfaces([model.object], 8);
  assert.equal(surfaces.hasCeiling, true);
  // Looking straight down from above the room: the first hit is the floor (y = 0), not the ceiling (y = 2.5).
  const down = () => {
    const hits: Intersection[] = [];
    new Raycaster(new Vector3(-2, 5, 0), new Vector3(0, -1, 0)).intersectObject(model.object, true, hits);
    return hits[0]?.point.y;
  };
  assert.ok(Math.abs(down()! - 0) < 1e-6);
  surfaces.setCeilingHidden(false);
  assert.ok(Math.abs(down()! - 2.5) < 1e-6);
  surfaces.dispose();
  model.dispose();
});

test("Path Capture vertex colours are converted from camera sRGB to linear once", async () => {
  const model = await parseGlb(room(), identity);
  const mesh = firstMesh(model.object);
  const before = mesh.geometry.getAttribute("color").getComponent(0, 0); // floor red 150/255
  assert.ok(Math.abs(before - 150 / 255) < 1e-6);
  const surfaces = prepareScanSurfaces([model.object], 1);
  const after = mesh.geometry.getAttribute("color").getComponent(0, 0);
  assert.ok(Math.abs(after - 0.305) < 0.002, `expected ~0.305 linear, got ${after}`);
  prepareScanSurfaces([model.object], 1).dispose(); // a second pass must not darken again
  assert.equal(mesh.geometry.getAttribute("color").getComponent(0, 0), after);
  surfaces.dispose();
  model.dispose();
});

test("scans without classification or from other tools are left alone", async () => {
  const bytes = readFileSync(new URL("../../../fixtures/venue/sample-triangle.glb", import.meta.url));
  const model = await parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, identity);
  const surfaces = prepareScanSurfaces([model.object], 8);
  assert.equal(surfaces.hasCeiling, false);
  surfaces.dispose();
  model.dispose();
});
