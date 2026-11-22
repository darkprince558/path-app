import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Float32BufferAttribute, Mesh, Raycaster, Vector3, type Intersection } from "three";
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

test("unlabelled phone scans hide downward-facing surfaces in the upper half", async () => {
  const model = await parseGlb(room(), identity);
  const mesh = firstMesh(model.object);
  // Like "Path Capture depth fusion": no surface labels, normals facing the scanner (ceilings face down).
  const classes = mesh.geometry.getAttribute("_ar_classification");
  const normals = new Float32Array(classes.count * 3);
  for (let i = 0; i < classes.count; i++) {
    const label = classes.getX(i);
    normals.set(label === 3 ? [0, -1, 0] : label === 2 ? [0, 1, 0] : [1, 0, 0], i * 3);
  }
  mesh.geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  mesh.geometry.deleteAttribute("_ar_classification");
  const surfaces = prepareScanSurfaces([model.object], 8);
  assert.equal(surfaces.hasCeiling, true);
  const down = () => {
    const hits: Intersection[] = [];
    new Raycaster(new Vector3(-2, 5, 0), new Vector3(0, -1, 0)).intersectObject(model.object, true, hits);
    return hits[0]?.point.y;
  };
  assert.ok(Math.abs(down()! - 0) < 1e-6, "the ceiling is skipped, the floor is hit");
  surfaces.setCeilingHidden(false);
  assert.ok(Math.abs(down()! - 2.5) < 1e-6, "shown again, the ceiling is hit");
  surfaces.dispose();
  model.dispose();
});

test("meshopt-compressed scans open and keep labels and colours", async () => {
  // fixtures/venue/classified-room.glb run through `gltf-transform meshopt` (quantized, EXT_meshopt_compression).
  const bytes = readFileSync(new URL("../../../fixtures/venue/classified-room-meshopt.glb", import.meta.url));
  const model = await parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, identity);
  assert.match(model.object.userData.generator, /^glTF-Transform/);
  const surfaces = prepareScanSurfaces([model.object], 8);
  assert.equal(surfaces.hasCeiling, true);
  const hits: Intersection[] = [];
  new Raycaster(new Vector3(-2, 5, 0), new Vector3(0, -1, 0)).intersectObject(model.object, true, hits);
  assert.ok(Math.abs(hits[0]!.point.y) < 1e-3, `floor hit expected, got y=${hits[0]?.point.y}`);
  const red = firstMesh(model.object).geometry.getAttribute("color").getComponent(0, 0);
  assert.ok(red > 0 && red < 0.6, `linear colour expected, got ${red}`);
  surfaces.dispose();
  model.dispose();
});
