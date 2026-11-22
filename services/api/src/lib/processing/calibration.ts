import { isDeepStrictEqual } from 'node:util';
import type { CaptureManifest } from '../capture/contract';
import { CPU_PROCESSOR } from './selection';

export const metricCoordinates = { units: 'metres', upAxis: 'Y', calibrated: true } as const;

/** Only the pinned native CPU pipeline validates and preserves ARKit's metric frame.
 * This is bundle provenance, not hardware attestation or a venue accuracy survey.
 * Unknown/legacy devices and synthetic/mock exports require explicit owner evidence.
 */
export function validatedMetricCapture(manifest: CaptureManifest, report: Record<string, unknown>,
  processor: { id: unknown; version: unknown }, inputSha256: string): boolean {
  return processor.id === CPU_PROCESSOR.id && processor.version === CPU_PROCESSOR.version &&
    /^i(?:Phone|Pad)\d+,\d+$/.test(manifest.device.model) && !/unknown|synthetic|simulator/i.test(manifest.device.osVersion) &&
    manifest.coordinateSystem.units === 'metres' && manifest.coordinateSystem.upAxis === 'Y' &&
    manifest.coordinateSystem.handedness === 'right' && manifest.coordinateSystem.matrixLayout === 'column-major' &&
    manifest.coordinateSystem.poseConvention === 'camera-to-capture' && report.mock !== true &&
    report.captureId === manifest.captureId && report.sourceManifestSha256 === inputSha256 && /^[a-f0-9]{64}$/.test(inputSha256) &&
    isDeepStrictEqual(report.coordinateSystem, manifest.coordinateSystem) && isDeepStrictEqual(report.entrancePose, manifest.entrancePose) &&
    typeof report.masterTriangles === 'number' && report.masterTriangles > 0 &&
    typeof report.sceneTriangles === 'number' && report.sceneTriangles > 0 && Array.isArray(report.frames) && report.frames.length > 0;
}

/** Automatic metric/frame claims survive translations and yaw, never scale, shear or tilt. */
export function preservesMetricFrame(matrix: readonly number[]): boolean {
  if (matrix.length !== 16 || !matrix.every(Number.isFinite)) return false;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-5;
  return near(matrix[3], 0) && near(matrix[7], 0) && near(matrix[11], 0) && near(matrix[15], 1) &&
    near(matrix[1], 0) && near(matrix[4], 0) && near(matrix[5], 1) && near(matrix[6], 0) && near(matrix[9], 0) &&
    near(matrix[0] ** 2 + matrix[2] ** 2, 1) && near(matrix[8] ** 2 + matrix[10] ** 2, 1) &&
    near(matrix[0] * matrix[8] + matrix[2] * matrix[10], 0) && near(matrix[0] * matrix[10] - matrix[8] * matrix[2], 1);
}

export function metricSpace(boundary: Record<string, unknown> | null): boolean {
  const frame = boundary?.coordinateSystem as Record<string, unknown> | undefined;
  return frame?.units === 'metres' && frame.upAxis === 'Y' && frame.calibrated === true;
}
