import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

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
const framePath = /^frames\/(frame-[0-9]{4,})\.jpg$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mib = 1024 * 1024;
const limits = {
  mesh: 128 * mib,
  pointcloud: 24 * mib,
  camera_frame: 8 * mib,
  preview: 8 * mib,
  frame_metadata: 2 * mib,
  manifest: mib,
};

function checkPose(pose) {
  const valid =
    Array.isArray(pose) &&
    pose.length === 16 &&
    pose.every(Number.isFinite) &&
    pose[3] === 0 &&
    pose[7] === 0 &&
    pose[11] === 0 &&
    pose[15] === 1;
  requireCapture(valid, 'Expected a column-major affine camera pose');
  const dot = (i, j) => pose[i] * pose[j] + pose[i + 1] * pose[j + 1] + pose[i + 2] * pose[j + 2];
  for (const i of [0, 4, 8]) {
    requireCapture(Math.abs(dot(i, i) - 1) < 0.005, 'Camera axes must have unit length');
  }
  const determinant =
    pose[0] * (pose[5] * pose[10] - pose[6] * pose[9]) -
    pose[4] * (pose[1] * pose[10] - pose[2] * pose[9]) +
    pose[8] * (pose[1] * pose[6] - pose[2] * pose[5]);
  requireCapture(
    Math.abs(dot(0, 4)) + Math.abs(dot(0, 8)) + Math.abs(dot(4, 8)) < 0.01 && determinant > 0.99,
    'Expected a right-handed rigid camera pose',
  );
}

function json(bytes, path) {
  try {
    return JSON.parse(bytes.toString('utf8'));
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
      requireCapture(frames.length > 0 && frames.length <= 256, 'Expected 1–256 selected frames');
      for (const file of frames) {
        requireCapture(
          file.isFile() && framePath.test('frames/' + file.name),
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
  const manifest = json(manifestBytes, 'manifest.json');
  requireCapture(
    manifest?.version === '1.0' &&
      typeof manifest.captureId === 'string' &&
      uuid.test(manifest.captureId),
    'Invalid capture ID or manifest version',
  );
  if (expectedId !== undefined) {
    requireCapture(
      manifest.captureId.toLowerCase() === expectedId.toLowerCase(),
      'Capture ID mismatch',
    );
  }
  requireCapture(
    typeof manifest.createdAt === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(manifest.createdAt) &&
      Number.isFinite(Date.parse(manifest.createdAt)),
    'Expected a UTC capture timestamp',
  );
  requireCapture(
    typeof manifest.device?.model === 'string' &&
      manifest.device.model.trim() &&
      manifest.device.platform === 'iOS' &&
      manifest.device.scanner === 'ARKit',
    'Missing ARKit device details',
  );
  const axes = manifest.coordinateSystem;
  requireCapture(
    axes?.units === 'meters' &&
      axes.upAxis === 'Y' &&
      axes.handedness === 'right' &&
      axes.matrixOrder === 'column-major',
    'Unsupported coordinate system',
  );
  checkPose(manifest.entrancePose);
  requireCapture(
    Array.isArray(manifest.trackingWarnings) &&
      manifest.trackingWarnings.every((w) => typeof w === 'string'),
    'Invalid tracking warnings',
  );
  requireCapture(
    Array.isArray(manifest.files) && manifest.files.length === actual.size,
    'File inventory mismatch',
  );
  const selected = new Set();
  const assets = new Map();
  let total = 0;
  for (const entry of manifest.files) {
    requireCapture(entry && actual.delete(entry.path), 'Missing, duplicate or unlisted capture file');
    const type = roles.get(entry.path) ?? 'camera_frame';
    requireCapture(
      entry.type === type &&
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
  const frames = json(assets.get('frames.json'), 'frames.json')?.frames;
  requireCapture(
    Array.isArray(frames) && frames.length > 0 && frames.length === selected.size,
    'Frame inventory mismatch',
  );
  for (const frame of frames) {
    requireCapture(
      frame &&
        selected.delete(frame.path) &&
        framePath.exec(frame.path)?.[1] === frame.frameId &&
        Number.isSafeInteger(frame.timestampMs) &&
        frame.timestampMs >= 0,
      'Invalid frame ID, path or timestamp',
    );
    checkPose(frame.cameraPose);
  }
  return { manifest, manifestHash: sha256(manifestBytes), frames, assets };
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
