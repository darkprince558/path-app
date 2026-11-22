import { createRoom, disposeRoom } from "../../src/lib/navmesh-room.ts";
import { trianglesFromObject } from "../../src/lib/navmesh.ts";

export const approvedTransform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 7, -4, 1];
export const approvedMetadata = { alignmentVerified: true, coordinateSystem: { units: "metres", upAxis: "Y", calibrated: true } };
export const spacePoint = (p: { x: number; y: number; z: number }) => ({ x: p.x + 11, y: p.y + 7.5, z: p.z - 5 });

/** Self-contained GLB with a glTF node transform separate from the approved scan transform. */
export function roomGlb(options: { closed?: boolean; noFloor?: boolean } = {}): ArrayBuffer {
  const room = createRoom(options);
  if (options.noFloor) {
    // Retain only a vertical plane: there must be no horizontal wall tops to navigate.
    const geometry = { positions: [-4, 0, 0, 4, 0, 0, -4, 3, 0], indices: [0, 1, 2] };
    disposeRoom(room); return encode(geometry);
  }
  try { return encode(trianglesFromObject(room)); } finally { disposeRoom(room); }
}
function encode(input: { positions: number[]; indices: number[] }) {
  const binary = new Float32Array(input.indices.flatMap(index => input.positions.slice(index * 3, index * 3 + 3)));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < binary.length; i++) { min[i % 3] = Math.min(min[i % 3]!, binary[i]!); max[i % 3] = Math.max(max[i % 3]!, binary[i]!); }
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ translation: [1, 0.5, -1], children: [1] }, { mesh: 0 }], buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: binary.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: binary.length / 3, type: "VEC3", min, max }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  }));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const result = new ArrayBuffer(28 + jsonLength + binary.byteLength), view = new DataView(result);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(result, 20, jsonLength).fill(32); new Uint8Array(result, 20, json.length).set(json);
  view.setUint32(20 + jsonLength, binary.byteLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  new Uint8Array(result, 28 + jsonLength).set(new Uint8Array(binary.buffer));
  return result;
}
