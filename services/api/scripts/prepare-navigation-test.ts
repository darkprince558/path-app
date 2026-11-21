/**
 * Synthetic browser verification only: this is not a reconstructed room or a real-capture acceptance test.
 * Run with TEST_DATABASE_URL pointing to a disposable migrated localhost database and placeholder Auth0
 * configuration (the scan service imports the API authentication module). Leaves records for browser use.
 * NAVIGATION_TEST_DIR defaults to a fresh directory in /tmp; report.json records IDs and SCAN_STORAGE_DIR.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { connectDatabase } from '../src/db/client';
import { destinations, eventDestinations, eventPaths, eventSpaces, events, navEdges, navNodes,
  paths, pathWaypoints, spaces, users } from '../src/db/schema';
import { boundedFormData, createScan, downloadScan, parseUpload } from '../src/lib/api/scans';
import { validateWaypoints } from '../src/lib/api/paths';
import { LocalScanStorage } from '../src/lib/storage';

function pngChunk(type: string, bytes: Buffer) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length, 0); body.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function syntheticGlb() {
  // 2x2 RGBA red/blue/yellow/green checker texture, generated locally without external resources.
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.from([0, 240, 60, 60, 255, 60, 100, 240, 255,
    0, 240, 210, 50, 255, 50, 200, 100, 255]);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
  const positions = Buffer.alloc(48);
  [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1].forEach((n, i) => positions.writeFloatLE(n, i * 4));
  const uv = Buffer.alloc(32);
  [0, 0, 1, 0, 1, 1, 0, 1].forEach((n, i) => uv.writeFloatLE(n, i * 4));
  const indices = Buffer.alloc(12);
  [0, 2, 1, 0, 3, 2].forEach((n, i) => indices.writeUInt16LE(n, i * 2));
  const binary = Buffer.concat([positions, uv, indices, png]);
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0', generator: '!404 SYNTHETIC navigation verification fixture' },
    extensionsUsed: ['KHR_materials_unlit'], scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48, target: 34962 },
      { buffer: 0, byteOffset: 48, byteLength: 32, target: 34962 },
      { buffer: 0, byteOffset: 80, byteLength: 12, target: 34963 },
      { buffer: 0, byteOffset: 92, byteLength: png.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, 0, -1], max: [1, 0, 1] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' }],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    samplers: [{ magFilter: 9728, minFilter: 9728 }], textures: [{ source: 0, sampler: 0 }],
    materials: [{ name: 'Synthetic checker', doubleSided: true, extensions: { KHR_materials_unlit: {} },
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
  }));
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const binarySize = Math.ceil(binary.length / 4) * 4;
  const result = Buffer.alloc(12 + 8 + jsonSize + 8 + binarySize);
  result.write('glTF'); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonSize, 12); result.write('JSON', 16);
  result.fill(0x20, 20, 20 + jsonSize); json.copy(result, 20);
  const offset = 20 + jsonSize;
  result.writeUInt32LE(binarySize, offset); result.write('BIN\0', offset + 4); binary.copy(result, offset + 8);
  return result;
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a disposable migrated localhost PostgreSQL database');
const parsedUrl = new URL(databaseUrl);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname) || !/(test|stage1)/i.test(parsedUrl.pathname))
  throw new Error('This fixture script requires a localhost database with test or stage1 in its name');
process.env.DATABASE_URL = databaseUrl;
const directory = process.env.NAVIGATION_TEST_DIR
  ? path.resolve(process.env.NAVIGATION_TEST_DIR) : await mkdtemp(path.join(tmpdir(), 'path-navigation-test-'));
await mkdir(directory, { recursive: true });
const storageRoot = path.join(directory, 'storage');
const storage = new LocalScanStorage(storageRoot);
const bytes = syntheticGlb();
await writeFile(path.join(directory, 'SYNTHETIC-textured-plane.glb'), bytes);
const { db, client } = connectDatabase();
try {
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({ auth0Sub: `test|navigation-${suffix}`,
    username: `navigation_${suffix}`, displayName: 'SYNTHETIC browser test owner' }).returning();
  const [publicSpace, privateSpace] = await db.insert(spaces).values([
    { ownerId: owner.id, name: 'SYNTHETIC textured navigation test', visibility: 'public' as const,
      boundary: { coordinateSystem: { units: 'relative', upAxis: 'Y', calibrated: false } },
      description: 'Generated two-triangle checker plane. Software verification only; not a reconstructed room.' },
    { ownerId: owner.id, name: 'SYNTHETIC private navigation test', visibility: 'private' as const,
      boundary: { coordinateSystem: { units: 'relative', upAxis: 'Y', calibrated: false } } },
  ]).returning();
  // Column-major T(3,0,-2) R_y(+90deg) S(2): (x,y,z) -> (3+2z, 2y, -2-2x).
  const alignment = [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 3, 0, -2, 1];
  const upload = async (spaceId: string, visibility: 'public' | 'private', name: string, matrix = alignment) => {
    const form = new FormData();
    form.set('file', new File([bytes], 'SYNTHETIC-textured-plane.glb'));
    form.set('name', name); form.set('visibility', visibility);
    form.set('transform', JSON.stringify(matrix));
    form.set('metadata', JSON.stringify({ synthetic: true, purpose: 'software verification, not real capture',
      alignmentVerified: true, coordinateSystem: { units: 'relative', upAxis: 'Y', calibrated: false } }));
    const parsed = parseUpload(await boundedFormData(new Request('http://localhost/api/scans', { method: 'POST', body: form })));
    return createScan(db, storage, owner, spaceId, parsed.input, new Uint8Array(await parsed.file.arrayBuffer()), parsed.file.name);
  };
  const scan = await upload(publicSpace.id, 'public', 'SYNTHETIC textured plane');
  const secondAlignment = [...alignment]; secondAlignment[12] = 7;
  const secondScan = await upload(publicSpace.id, 'public', 'SYNTHETIC second aligned scan', secondAlignment);
  const hiddenScan = await upload(publicSpace.id, 'private', 'SYNTHETIC private scan in public space');
  const privateScan = await upload(privateSpace.id, 'private', 'SYNTHETIC private space scan');
  const nodes = await db.insert(navNodes).values([
    { spaceId: publicSpace.id, x: 3, y: 0, z: -0.5, metadata: { name: 'Start', scanId: scan.id, scanLocal: [-0.75, 0, 0] } },
    { spaceId: publicSpace.id, x: 3, y: 0, z: -2, metadata: { name: 'Middle', scanId: scan.id, scanLocal: [0, 0, 0] } },
    { spaceId: publicSpace.id, x: 3, y: 0, z: -3.5, metadata: { name: 'Destination', scanId: scan.id, scanLocal: [0.75, 0, 0] } },
  ]).returning();
  await db.insert(navEdges).values([0, 1].map(i => ({ spaceId: publicSpace.id,
    fromNodeId: nodes[i].id, toNodeId: nodes[i + 1].id, distance: 1.5, bidirectional: false })));
  const [destination] = await db.insert(destinations).values({ spaceId: publicSpace.id, nodeId: nodes[2].id,
    name: 'SYNTHETIC destination' }).returning();
  await validateWaypoints(db, publicSpace.id, nodes.map(n => n.id));
  const [savedPath] = await db.insert(paths).values({ ownerId: owner.id, spaceId: publicSpace.id,
    name: 'SYNTHETIC saved route', visibility: 'public' }).returning();
  await db.insert(pathWaypoints).values(nodes.map((node, sequence) => ({
    pathId: savedPath.id, spaceId: publicSpace.id, nodeId: node.id, sequence,
  })));
  const [event] = await db.insert(events).values({ ownerId: owner.id, name: 'SYNTHETIC public navigation event', visibility: 'public' }).returning();
  await db.insert(eventSpaces).values({ eventId: event.id, spaceId: publicSpace.id });
  await db.insert(eventPaths).values({ eventId: event.id, pathId: savedPath.id });
  await db.insert(eventDestinations).values({ eventId: event.id, destinationId: destination.id });
  assert.deepEqual((await downloadScan(db, storage, null, scan.id)).bytes, bytes);
  for (const id of [hiddenScan.id, privateScan.id]) await assert.rejects(downloadScan(db, storage, null, id), { status: 404 });
  const report = { synthetic: true, note: 'Software verification only. Real capture, physical scale and Auth0 login remain unverified.',
    storageRoot, modelFile: path.join(directory, 'SYNTHETIC-textured-plane.glb'), byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), ownerId: owner.id,
    spaceId: publicSpace.id, privateSpaceId: privateSpace.id, scanId: scan.id, secondScanId: secondScan.id,
    hiddenScanId: hiddenScan.id, privateScanId: privateScan.id, pathId: savedPath.id,
    destinationId: destination.id, eventId: event.id, nodes, transform: alignment };
  const reportFile = path.join(directory, 'report.json');
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportFile, ...report }, null, 2));
} finally { await client.end(); }
