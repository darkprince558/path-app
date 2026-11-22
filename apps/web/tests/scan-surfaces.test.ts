import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DoubleSide, Float32BufferAttribute, Mesh, Raycaster, Vector3, type Intersection, type Object3D } from "three";
import { parseGlb } from "../src/lib/glb.ts";
import { LOW_CUT, prepareScanSurfaces } from "../src/lib/scan-surfaces.ts";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const bytesOf = (name: string) => {
  const bytes = readFileSync(new URL(`../../../fixtures/venue/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
// A 6 x 4 x 2.5 m room shaped like Path Capture's export (tools/make_classified_room.py).
const room = () => bytesOf("classified-room.glb");

function firstMesh(root: { traverse(cb: (o: unknown) => void): void }) {
  let mesh: Mesh | undefined;
  root.traverse((object) => { if (!mesh && object instanceof Mesh) mesh = object; });
  return mesh!;
}

/** Height of the first surface straight down from above the room at (x, z). */
function down(root: Object3D, x = -2, z = 0) {
  const hits: Intersection[] = [];
  new Raycaster(new Vector3(x, 5, z), new Vector3(0, -1, 0)).intersectObject(root, true, hits);
  return hits[0]?.point.y;
}

/** Height of the first surface met looking sideways at the back wall, at height y. */
function wallHit(root: Object3D, y: number) {
  const hits: Intersection[] = [];
  new Raycaster(new Vector3(0, y, 0), new Vector3(0, 0, -1)).intersectObject(root, true, hits);
  return hits[0]?.point.z;
}

test("labelled scans: floor and ceiling are measured and the three wall cuts work", async () => {
  const model = await parseGlb(room(), identity);
  const surfaces = prepareScanSurfaces([model.object], 8);
  assert.ok(Math.abs(surfaces.floorY) < 0.03, `floor at 0, got ${surfaces.floorY}`);
  assert.ok(surfaces.ceilingY !== null && Math.abs(surfaces.ceilingY - 2.5) < 0.03, `ceiling at 2.5, got ${surfaces.ceilingY}`);
  assert.deepEqual(surfaces.cuts, ["low", "ceiling", "full"]);
  assert.equal(surfaces.defaultCut, "low");
  // Low walls (the start): the ceiling and the top of the walls are cut away for clicks.
  assert.ok(Math.abs(down(model.object)!) < 1e-6, "the floor is hit, not the ceiling");
  assert.equal(wallHit(model.object, 2.0), undefined, "the wall above chest height is cut");
  assert.ok(wallHit(model.object, LOW_CUT - 0.3) !== undefined, "the wall below the cut is still there");
  assert.equal(firstMesh(model.object).material instanceof Array ? undefined : (firstMesh(model.object).material as { side: number }).side, DoubleSide);
  // No ceiling: full-height walls, still no ceiling.
  surfaces.setCut("ceiling");
  assert.ok(Math.abs(down(model.object)!) < 1e-6);
  assert.ok(wallHit(model.object, 2.0) !== undefined);
  // Everything: the ceiling is back.
  surfaces.setCut("full");
  assert.ok(Math.abs(down(model.object)! - 2.5) < 1e-6);
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

test("a flat model has nothing to cut", async () => {
  const model = await parseGlb(bytesOf("sample-triangle.glb"), identity);
  const surfaces = prepareScanSurfaces([model.object], 8);
  assert.equal(surfaces.ceilingY, null);
  assert.deepEqual(surfaces.cuts, []);
  assert.equal(surfaces.defaultCut, "full");
  surfaces.dispose();
  model.dispose();
});

test("unlabelled phone scans find floor and ceiling from the surfaces' facing", async () => {
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
  (mesh.material as { side: number }).side = 0; // FrontSide, like a single-sided export
  const surfaces = prepareScanSurfaces([model.object], 8);
  assert.equal((mesh.material as { side: number }).side, DoubleSide, "cutting shows both sides");
  assert.ok(Math.abs(surfaces.floorY) < 0.03);
  assert.ok(surfaces.ceilingY !== null && Math.abs(surfaces.ceilingY - 2.5) < 0.03);
  assert.ok(Math.abs(down(model.object)!) < 1e-6, "cut: the floor is hit");
  surfaces.setCut("full");
  assert.ok(Math.abs(down(model.object)! - 2.5) < 1e-6, "uncut: the ceiling is hit");
  assert.equal((mesh.material as { side: number }).side, 0, "uncut keeps the file's own side");
  surfaces.setCut("low");
  surfaces.dispose();
  assert.equal((mesh.material as { side: number }).side, 0, "dispose restores the file's own side");
  model.dispose();
});

test("meshopt-compressed scans open and keep labels and colours", async () => {
  // fixtures/venue/classified-room.glb run through `gltf-transform meshopt` (quantized, EXT_meshopt_compression).
  const model = await parseGlb(bytesOf("classified-room-meshopt.glb"), identity);
  assert.match(model.object.userData.generator, /^glTF-Transform/);
  const surfaces = prepareScanSurfaces([model.object], 8);
  assert.ok(surfaces.ceilingY !== null && Math.abs(surfaces.ceilingY - 2.5) < 0.05);
  assert.ok(Math.abs(down(model.object)!) < 1e-3, `floor hit expected, got y=${down(model.object)}`);
  const red = firstMesh(model.object).geometry.getAttribute("color").getComponent(0, 0);
  assert.ok(red > 0 && red < 0.6, `linear colour expected, got ${red}`);
  surfaces.dispose();
  model.dispose();
});
