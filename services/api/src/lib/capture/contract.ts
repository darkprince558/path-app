import { z } from 'zod';

function affineTransform(wTolerance: number) {
  return z.array(z.number().finite()).length(16).refine(matrix => {
    if (matrix.length !== 16 || matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 ||
      matrix[15] < 1 - wTolerance || matrix[15] > 1 + wTolerance) return false;
    // Normalize before testing the determinant so valid small-unit reconstructions remain usable.
    const scale = Math.max(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map(i => Math.abs(matrix[i])));
    if (!scale) return false;
    const m = matrix.map(value => value / scale);
    const determinant = m[0] * (m[5] * m[10] - m[9] * m[6])
      - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    return Number.isFinite(determinant) && Math.abs(determinant) > Number.EPSILON;
  }, 'Transform must be a nonsingular affine column-major matrix');
}

export const transform = affineTransform(0);
// ARKit stores camera poses as floats. Retain the recorded w for checksum and provenance checks.
const cameraPose = affineTransform(1e-6);

export const MAX_CAPTURE_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 512 * 1024 * 1024;
export const MAX_CAPTURE_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_CAPTURE_FRAMES = 1000;
export const REQUIRED_CAPTURE_FILES = ['source.glb', 'points.ply', 'frames.json', 'preview.jpg'] as const;
const frameId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).refine(value => value === value.trim());

// No decoding/normalization: reject ambiguous paths rather than trying to repair them.
export const capturePath = z.string().max(160).refine(value =>
  value === value.trim() && ((REQUIRED_CAPTURE_FILES as readonly string[]).includes(value) ||
  /^frames\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.jpg$/.test(value)), 'Unsupported or unsafe capture path');
export const fileDigest = z.object({
  byteSize: z.number().int().positive().max(MAX_CAPTURE_FILE_BYTES),
  sha256: z.string().length(64).regex(/^[0-9a-f]{64}$/),
}).strict();

export const captureManifest = z.object({
  version: z.literal(1), captureId: z.uuid(),
  device: z.object({ model: z.string().min(1).max(200), osVersion: z.string().min(1).max(100) }).strict(),
  coordinateSystem: z.object({
    units: z.literal('metres'), upAxis: z.literal('Y'), handedness: z.literal('right'),
    matrixLayout: z.literal('column-major'), poseConvention: z.literal('camera-to-capture'),
  }).strict(),
  entrancePose: cameraPose,
  capturedAt: z.iso.datetime({ offset: true }).optional(),
  trackingWarnings: z.array(z.string().min(1).max(1000)).max(100).default([]),
  files: z.array(fileDigest.extend({ path: capturePath }).strict()).min(5).max(MAX_CAPTURE_FRAMES + 4),
}).strict().superRefine((manifest, ctx) => {
  const paths = new Set(manifest.files.map(file => file.path));
  if (paths.size !== manifest.files.length) ctx.addIssue({ code: 'custom', message: 'Duplicate file paths' });
  for (const required of REQUIRED_CAPTURE_FILES) {
    if (!paths.has(required)) ctx.addIssue({ code: 'custom', message: `Missing required file: ${required}` });
  }
  if (manifest.files.reduce((sum, file) => sum + file.byteSize, 0) > MAX_CAPTURE_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'Capture exceeds 256 MiB' });
  }
  const frames = manifest.files.find(file => file.path === 'frames.json');
  if (frames && frames.byteSize > MAX_CAPTURE_JSON_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'frames.json exceeds 2 MiB' });
  }
});

export const captureRegistration = z.object({ spaceId: z.uuid(), manifest: captureManifest }).strict();
export type CaptureManifest = z.infer<typeof captureManifest>;
export type FileDigest = z.infer<typeof fileDigest>;

export const captureFrameIndex = z.object({
  version: z.literal(1), captureId: z.uuid(),
  frames: z.array(z.object({
    id: frameId, imagePath: capturePath, cameraPose,
    timestampSeconds: z.number().finite().nonnegative(),
    width: z.number().int().positive().max(32768), height: z.number().int().positive().max(32768),
    intrinsics: z.object({
      fx: z.number().finite().positive(), fy: z.number().finite().positive(),
      cx: z.number().finite(), cy: z.number().finite(),
    }).strict().optional(),
  }).strict()).min(1).max(MAX_CAPTURE_FRAMES),
}).strict().superRefine((index, ctx) => {
  if (new Set(index.frames.map(frame => frame.id)).size !== index.frames.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate frame IDs' });
  }
  for (const frame of index.frames) {
    if (frame.imagePath !== `frames/${frame.id}.jpg`) {
      ctx.addIssue({ code: 'custom', message: 'Frame imagePath must match its stable ID' });
    }
  }
});

export function validateFrameReferences(value: unknown, manifest: CaptureManifest) {
  return captureFrameIndex.superRefine((index, ctx) => {
    if (index.captureId !== manifest.captureId) ctx.addIssue({ code: 'custom', message: 'Frame capture ID does not match manifest' });
    const images = new Set(manifest.files.filter(file => file.path.startsWith('frames/')).map(file => file.path));
    if (index.frames.length !== images.size || index.frames.some(frame => !images.has(frame.imagePath))) {
      ctx.addIssue({ code: 'custom', message: 'Every manifest frame image must have exactly one frame reference' });
    }
  }).parse(value);
}

// Normalize object key ordering for retry identity, while retaining array order.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
