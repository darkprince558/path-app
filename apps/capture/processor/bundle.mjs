import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { captureManifest, capturePath, validateFrameReferences, canonicalJson, MAX_CAPTURE_FILE_BYTES, MAX_CAPTURE_FRAMES, MAX_CAPTURE_JSON_BYTES } from './contract.mjs';

export class InvalidCapture extends Error {}
export function requireCapture(condition, message) {
  if (!condition) throw new InvalidCapture(message);
}

const roles = new Map([
  ['source.glb', 'mesh'],
  ['points.ply', 'pointcloud'],
  ['frames.json', 'frame_metadata'],
  ['preview.jpg', 'preview'],
]);
const framePath = /^frames\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jpg$/;
const mib = 1024 * 1024;
const limits = Object.fromEntries([...roles.values(), 'camera_frame'].map(role => [role, MAX_CAPTURE_FILE_BYTES]));
limits.frame_metadata = MAX_CAPTURE_JSON_BYTES;
limits.manifest = MAX_CAPTURE_JSON_BYTES;

function json(bytes, path) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidCapture('Invalid JSON in ' + path);
  }
}

async function regularBytes(path, limit) {
  const stat = await lstat(path);
  requireCapture(
    stat.isFile() && stat.size > 0 && stat.size <= limit,
    'Expected a bounded regular file: ' + path,
  );
  return readFile(path);
}

export async function checkJPEG(bytes, path) {
  try {
    const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
    requireCapture((await image.metadata()).format === 'jpeg', 'Expected JPEG');
    // Force pixel decoding to catch truncated images with a readable header.
    await image.resize(32, 32, { fit: 'inside' }).raw().toBuffer();
  } catch {
    throw new InvalidCapture('Invalid JPEG: ' + path);
  }
}

export async function readBundle(root, expectedId) {
  requireCapture((await lstat(root)).isDirectory(), 'Expected a capture directory');
  const entries = await readdir(root, { withFileTypes: true });
  const actual = new Set();
  for (const entry of entries) {
    if (entry.name === 'frames' && entry.isDirectory()) {
      const frames = await readdir(join(root, 'frames'), { withFileTypes: true });
      requireCapture(frames.length > 0 && frames.length <= MAX_CAPTURE_FRAMES, 'Expected 1–1000 selected frames');
      for (const file of frames) {
        requireCapture(
          file.isFile() && framePath.test('frames/' + file.name) && capturePath.safeParse('frames/' + file.name).success,
          'Unexpected entry in frames/',
        );
        actual.add('frames/' + file.name);
      }
    } else {
      requireCapture(
        entry.isFile() && (entry.name === 'manifest.json' || roles.has(entry.name)),
        'Unexpected entry in capture: ' + entry.name,
      );
      if (entry.name !== 'manifest.json') actual.add(entry.name);
    }
  }
  const manifestBytes = await regularBytes(join(root, 'manifest.json'), limits.manifest);
  const parsed = captureManifest.safeParse(json(manifestBytes, 'manifest.json'));
  requireCapture(parsed.success, 'Capture manifest does not match the backend version 1 contract');
  const manifest = parsed.data;
  if (expectedId !== undefined) {
    requireCapture(manifest.captureId.toLowerCase() === expectedId.toLowerCase(), 'Device capture ID mismatch');
  }
  requireCapture(manifest.files.length === actual.size, 'File inventory mismatch');
  const selected = new Set();
  const assets = new Map();
  let total = 0;
  for (const entry of manifest.files) {
    requireCapture(entry && actual.delete(entry.path), 'Missing, duplicate or unlisted capture file');
    const type = roles.get(entry.path) ?? 'camera_frame';
    requireCapture(
      Number.isSafeInteger(entry.byteSize) &&
        entry.byteSize > 0 &&
        entry.byteSize <= limits[type],
      'Invalid file entry: ' + entry.path,
    );
    total += entry.byteSize;
    requireCapture(total <= 256 * mib, 'Capture exceeds 256 MiB');
    const bytes = await regularBytes(join(root, entry.path), Math.min(entry.byteSize, limits[type]));
    requireCapture(
      bytes.length === entry.byteSize && sha256(bytes) === entry.sha256,
      'Byte size or SHA-256 mismatch: ' + entry.path,
    );
    if (type === 'camera_frame' || type === 'preview') {
      await checkJPEG(bytes, entry.path);
      if (type === 'camera_frame') selected.add(entry.path);
    } else {
      assets.set(entry.path, bytes);
    }
  }
  requireCapture(
    [...roles.keys()].every((path) => manifest.files.some((f) => f.path === path)),
    'Missing required file',
  );
  let index;
  try { index = validateFrameReferences(json(assets.get('frames.json'), 'frames.json'), manifest); }
  catch { throw new InvalidCapture('Frame index does not match the backend contract or manifest'); }
  const frames = index.frames;
  requireCapture(
    Array.isArray(frames) && frames.length > 0 && frames.length === selected.size,
    'Frame inventory mismatch',
  );
  for (const frame of frames) {
    requireCapture(
      frame &&
        selected.delete(frame.imagePath) &&
        framePath.exec(frame.imagePath)?.[1] === frame.id &&
        Number.isFinite(frame.timestampSeconds) &&
        frame.timestampSeconds >= 0,
      'Invalid frame ID, path or timestamp',
    );
    const dimensions = await sharp(await regularBytes(join(root, frame.imagePath), MAX_CAPTURE_FILE_BYTES)).metadata();
    requireCapture(dimensions.width === frame.width && dimensions.height === frame.height, 'Frame dimensions do not match JPEG');
  }
  return { manifest, manifestHash: sha256(Buffer.from(canonicalJson(manifest))), manifestFileHash: sha256(manifestBytes), frames, assets };
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
