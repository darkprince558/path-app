import assert from "node:assert/strict";
import test from "node:test";
import { Mesh, MeshStandardMaterial, Vector3 } from "three";
import { parseGlb, scanMatrix, validateGlb } from "../src/lib/glb.ts";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function glb(json: object, binary?: Float32Array): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(jsonBytes.length / 4) * 4;
  const buffer = new ArrayBuffer(20 + jsonLength + (binary ? 8 + binary.byteLength : 0));
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20, jsonLength).fill(32); new Uint8Array(buffer, 20, jsonBytes.length).set(jsonBytes);
  if (binary) {
    view.setUint32(20 + jsonLength, binary.byteLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
    new Uint8Array(buffer, 28 + jsonLength).set(new Uint8Array(binary.buffer));
  }
  return buffer;
}
function triangle() {
  return glb({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [2, 0, 0] }],
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.5, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.7 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  }, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
}

test("embedded GLB keeps material and node hierarchy under scan-to-space alignment", async () => {
  const transform = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 3, -4, 1];
  const model = await parseGlb(triangle(), transform);
  assert.deepEqual(model.bounds.min.toArray(), [14, 3, -4]);
  assert.deepEqual(model.bounds.max.toArray(), [16, 5, -4]);
  let mesh: Mesh | undefined;
  model.object.traverse((child) => { if (child instanceof Mesh) mesh = child; });
  assert.ok(mesh);
  assert.ok(mesh.material instanceof MeshStandardMaterial);
  assert.equal(mesh.material.roughness, 0.7);
  assert.deepEqual(mesh.position.toArray(), [2, 0, 0]);
  assert.deepEqual(model.object.worldToLocal(new Vector3(14, 3, -4)).toArray(), [2, 0, 0]);
  model.dispose();
});

test("external buffers, textures, and extension URIs cannot trigger requests", () => {
  for (const uri of ["https://example.com/private.jpg", "//example.com/a", "texture.png", "file:///etc/passwd", "blob:authored"]) {
    assert.throws(() => validateGlb(glb({ asset: { version: "2.0" }, images: [{ uri }] })), /external file/);
  }
  assert.throws(() => validateGlb(glb({ extensions: { custom: { uri: "https://example.com/a" } } })), /external file/);
  assert.doesNotThrow(() => validateGlb(glb({ images: [{ uri: "data:image/png;base64,AA==" }] })));
});

test("malformed GLB lengths and alignment are rejected before decoding", () => {
  assert.throws(() => validateGlb(new ArrayBuffer(4)), /binary GLB/);
  const bytes = triangle(); new DataView(bytes).setUint32(12, bytes.byteLength, true);
  assert.throws(() => validateGlb(bytes), /chunk length/);
  assert.throws(() => scanMatrix([1, 2]), /affine/);
  assert.throws(() => scanMatrix(identity.map((value, i) => i === 3 ? 1 : value)), /affine/);
  assert.throws(() => scanMatrix(identity.map((value, i) => i === 0 ? 0 : value)), /zero scale/);
  assert.throws(() => scanMatrix(identity.map((value, i) => i === 12 ? NaN : value)), /finite/);
});

test("empty GLB scenes do not report successful loading", async () => {
  await assert.rejects(parseGlb(glb({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [] }] }), identity), /no usable mesh/);
});
