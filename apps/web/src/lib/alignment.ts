import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { Position } from "./space-api";

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column vectors: scale, rotate X then Y then Z, translate. T * Rz * Ry * Rx * S. */
export function alignmentMatrix(scale: number, rotationDegrees: Position, translation: Position): number[] {
  if (![scale, ...Object.values(rotationDegrees), ...Object.values(translation)].every(Number.isFinite) || scale <= 0) {
    throw new Error("Use a positive scale and finite rotation and position values.");
  }
  const radians = Math.PI / 180;
  return new Matrix4().makeTranslation(translation.x, translation.y, translation.z)
    .multiply(new Matrix4().makeRotationZ(rotationDegrees.z * radians))
    .multiply(new Matrix4().makeRotationY(rotationDegrees.y * radians))
    .multiply(new Matrix4().makeRotationX(rotationDegrees.x * radians))
    .multiply(new Matrix4().makeScale(scale, scale, scale)).toArray();
}

export function calibrationScale(a: Position, b: Position, measuredMetres: number): number {
  const length = new Vector3(a.x, a.y, a.z).distanceTo(new Vector3(b.x, b.y, b.z));
  if (!Number.isFinite(length) || length <= 1e-9 || !Number.isFinite(measuredMetres) || measuredMetres <= 0) {
    throw new Error("Choose two different points and enter their measured distance in metres.");
  }
  return measuredMetres / length;
}

/** Restore controls only when the saved matrix is a positive uniform similarity. */
export function alignmentControls(elements: number[]) {
  const matrix = new Matrix4().fromArray(elements);
  const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
  matrix.decompose(position, rotation, scale);
  const rebuilt = new Matrix4().compose(position, rotation, scale);
  if (scale.x <= 0 || Math.abs(scale.x - scale.y) > 1e-7 || Math.abs(scale.x - scale.z) > 1e-7 ||
      rebuilt.elements.some((v, i) => Math.abs(v - elements[i]!) > 1e-7)) return null;
  const angles = new Euler().setFromQuaternion(rotation, "ZYX");
  return { scale: scale.x, translation: { x: position.x, y: position.y, z: position.z },
    rotation: { x: angles.x * 180 / Math.PI, y: angles.y * 180 / Math.PI, z: angles.z * 180 / Math.PI } };
}
