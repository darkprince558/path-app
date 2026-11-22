import { Logger, NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { dedup, prune, simplifyPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import validator from 'gltf-validator';
import sharp from 'sharp';
import { checkJPEG, InvalidCapture, requireCapture } from './bundle.mjs';

const properties = ['float x', 'float y', 'float z', 'uchar red', 'uchar green', 'uchar blue'];
export function readPoints(bytes) {
  const marker = Buffer.from('end_header\n');
  const end = bytes.subarray(0, 4096).indexOf(marker);
  requireCapture(end >= 0, 'Missing binary PLY header');
  const lines = bytes
    .subarray(0, end)
    .toString('ascii')
    .trimEnd()
    .split('\n')
    .filter((l) => !l.startsWith('comment '));
  const countLine = /^element vertex ([0-9]+)$/.exec(lines[2]);
  requireCapture(
    lines.length === 9 &&
      lines[0] === 'ply' &&
      lines[1] === 'format binary_little_endian 1.0' &&
      countLine &&
      properties.every((p, i) => lines[i + 3] === 'property ' + p),
    'Expected native XYZ/RGB PLY',
  );
  const count = Number(countLine[1]);
  const data = bytes.subarray(end + marker.length);
  requireCapture(
    count > 0 && count <= 300_000 && data.length === 15 * count,
    'Invalid PLY vertex count',
  );
  for (let i = 0; i < data.length; i += 15) {
    for (const offset of [0, 4, 8]) {
      requireCapture(Math.abs(data.readFloatLE(i + offset)) < 1000, 'Invalid PLY coordinate');
    }
  }
  return { count, data };
}

// Render a scan overview from its approved geometry; private landmark photos stay in the source bundle.
export async function pointPreview({ count, data }) {
  const size = 512;
  const pixels = Buffer.alloc(size * size * 3, 38);
  const depth = new Float32Array(size * size).fill(-Infinity);
  const xyz = new Float32Array(3 * count);
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = data.readFloatLE(i * 15),
      y = data.readFloatLE(i * 15 + 4),
      z = data.readFloatLE(i * 15 + 8);
    const u = (x - z) / Math.SQRT2,
      v = y * 0.85 - (x + z) * 0.37;
    xyz.set([u, v, y * 0.52 + (x + z) * 0.6], i * 3);
    minX = Math.min(minX, u);
    maxX = Math.max(maxX, u);
    minY = Math.min(minY, v);
    maxY = Math.max(maxY, v);
  }
  const scale = (size - 12) / Math.max(maxX - minX, maxY - minY, 0.001);
  for (let i = 0; i < count; i++) {
    const x = Math.round(size / 2 + (xyz[3 * i] - (minX + maxX) / 2) * scale);
    const y = Math.round(size / 2 - (xyz[3 * i + 1] - (minY + maxY) / 2) * scale);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const p = (y + dy) * size + x + dx;
        if (xyz[3 * i + 2] <= depth[p]) continue;
        depth[p] = xyz[3 * i + 2];
        data.copy(pixels, 3 * p, 15 * i + 12, 15 * i + 15);
      }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 3 } })
    .jpeg()
    .toBuffer();
}

const io = new NodeIO().registerExtensions([KHRMaterialsUnlit]);
function triangleCount(primitives) {
  return primitives.reduce(
    (sum, p) => sum + (p.getIndices() ?? p.getAttribute('POSITION')).getCount() / 3,
    0,
  );
}

export async function models(bytes) {
  requireCapture(
    bytes.length >= 28 &&
      bytes.toString('ascii', 0, 4) === 'glTF' &&
      bytes.readUInt32LE(4) === 2 &&
      bytes.readUInt32LE(8) === bytes.length &&
      bytes.toString('ascii', 16, 20) === 'JSON',
    'Expected a binary glTF 2 model',
  );
  const length = bytes.readUInt32LE(12);
  requireCapture(length <= 2 ** 20 && length + 28 <= bytes.length, 'Invalid GLB JSON length');
  let json;
  try {
    json = JSON.parse(bytes.subarray(20, 20 + length));
  } catch {
    throw new InvalidCapture('Invalid GLB JSON');
  }
  requireCapture(
    json?.buffers?.length === 1 &&
      !('uri' in json.buffers[0]) &&
      (json.images ?? []).every((img) => !('uri' in img) && img.mimeType === 'image/jpeg') &&
      (json.extensionsUsed ?? []).every((name) => name === 'KHR_materials_unlit') &&
      json.accessors?.every((a) => !a.sparse && a.count > 0 && a.count <= 1_500_000),
    'Expected embedded native assets',
  );
  // Anchor-local transforms are baked into world positions by the iOS producer.
  requireCapture(
    json.scenes?.length === 1 &&
      json.scenes[0].nodes?.length === 1 &&
      json.scenes[0].nodes[0] === 0 &&
      json.nodes?.length === 1 &&
      json.nodes[0].mesh === 0 &&
      !['matrix', 'translation', 'scale', 'rotation', 'children'].some((k) => k in json.nodes[0]) &&
      json.meshes?.length === 1 &&
      json.meshes[0].primitives?.length &&
      json.meshes[0].primitives.every((p) => (p.mode ?? 4) === 4),
    'Expected a scan-world triangle mesh',
  );
  const validation = await validator.validateBytes(bytes, { maxIssues: 32 });
  requireCapture(
    validation.issues.numErrors === 0,
    'Invalid GLB: ' + validation.issues.messages.find((m) => m.severity === 0)?.message,
  );
  const document = await io.readBinary(bytes);
  for (const texture of document.getRoot().listTextures()) {
    await checkJPEG(texture.getImage(), 'embedded mesh texture');
  }
  document.setLogger(new Logger(Logger.Verbosity.SILENT));
  await document.transform(weld(), dedup(), prune({ keepAttributes: true }));
  const primitives = document.getRoot().listMeshes()[0]?.listPrimitives() ?? [];
  const fullTriangles = triangleCount(primitives);
  requireCapture(fullTriangles > 0, 'Empty surface after cleanup');
  const master = await io.writeBinary(document);
  await MeshoptSimplifier.ready;
  for (const primitive of primitives) {
    if (triangleCount([primitive]) >= 32) {
      simplifyPrimitive(primitive, {
        simplifier: MeshoptSimplifier,
        ratio: 0.5,
        error: 0.001,
        lockBorder: true,
      });
    }
  }
  await document.transform(prune({ keepAttributes: true }));
  const mobileTriangles = triangleCount(primitives);
  requireCapture(mobileTriangles > 0, 'Empty surface after simplification');
  const scene = await io.writeBinary(document);
  return { master, scene, fullTriangles, mobileTriangles };
}
