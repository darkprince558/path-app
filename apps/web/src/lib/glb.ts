import { Box3, Group, LoadingManager, Material, Matrix4, Mesh, Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export class ModelParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelParseError";
  }
}

/** Validate before GLTFLoader sees the document: uploads must be self-contained. */
export function validateGlb(buffer: ArrayBuffer): void {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) {
    throw new ModelParseError("The file is not a binary GLB model.");
  }
  if (view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength) {
    throw new ModelParseError("The GLB version or declared file length is invalid.");
  }
  let document: unknown;
  let offset = 12;
  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) throw new ModelParseError("The GLB has a truncated chunk.");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (length % 4 !== 0 || offset + 8 + length > buffer.byteLength) {
      throw new ModelParseError("The GLB has an invalid chunk length.");
    }
    if (offset === 12) {
      if (type !== 0x4e4f534a) throw new ModelParseError("The GLB is missing its JSON chunk.");
      try {
        document = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset + 8, length)));
      } catch {
        throw new ModelParseError("The GLB contains invalid JSON.");
      }
    }
    offset += 8 + length;
  }
  if (!document || typeof document !== "object") throw new ModelParseError("The GLB document is empty.");
  // Check extensions too. No model-authored remote/file URL may bypass the API's
  // asset authorization or contact a third party when a visitor opens a space.
  function checkUris(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "uri" && (typeof child !== "string" || !child.startsWith("data:"))) {
        throw new ModelParseError("The GLB references an external file. Export with embedded buffers and textures.");
      }
      checkUris(child);
    }
  }
  checkUris(document);
}

/** Column-major, affine scan-to-space matrix; translation occupies indices 12–14. */
export function scanMatrix(elements: readonly number[]): Matrix4 {
  if (elements.length !== 16 || !elements.every(Number.isFinite) ||
      elements[3] !== 0 || elements[7] !== 0 || elements[11] !== 0 || elements[15] !== 1) {
    throw new ModelParseError("The scan alignment must be a finite, affine 4×4 matrix.");
  }
  const matrix = new Matrix4().fromArray(elements);
  if (Math.abs(matrix.determinant()) < 1e-15) {
    throw new ModelParseError("The scan alignment has zero scale and cannot be displayed.");
  }
  return matrix;
}

export interface GlbModel {
  /** Wrapper applies alignment while preserving every GLTF node transform. */
  object: Group;
  bounds: Box3;
  dispose(): void;
}

export function disposeModel(root: Group): void {
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });
  for (const material of materials) material.dispose();
  for (const texture of textures) {
    texture.dispose();
    const image = texture.source.data as { close?: () => void } | undefined;
    image?.close?.();
  }
}

export async function parseGlb(buffer: ArrayBuffer, transform: readonly number[]): Promise<GlbModel> {
  validateGlb(buffer);
  const matrix = scanMatrix(transform);
  const manager = new LoadingManager();
  let resourceFailed = false;
  manager.onError = () => { resourceFailed = true; };
  manager.setURLModifier((url) => {
    // GLTFLoader creates blob URLs for embedded image bufferViews.
    if (!url.startsWith("blob:") && !url.startsWith("data:")) {
      throw new ModelParseError("External GLB resources are not allowed.");
    }
    return url;
  });
  const gltf = await new GLTFLoader(manager).parseAsync(buffer, "");
  const object = new Group();
  object.matrixAutoUpdate = false;
  object.matrix.copy(matrix);
  object.add(gltf.scene);
  try {
    if (resourceFailed) throw new ModelParseError("An embedded texture or buffer could not be decoded. Re-export the GLB with valid embedded resources.");
    let vertices = 0;
    object.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const positions = child.geometry.getAttribute("position");
      if (!positions) return;
      vertices += positions.count;
      for (let i = 0; i < positions.count; i++) {
        if (![positions.getX(i), positions.getY(i), positions.getZ(i)].every(Number.isFinite)) {
          throw new ModelParseError("The GLB has invalid vertex coordinates.");
        }
      }
    });
    object.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(object);
    if (!vertices || bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
      throw new ModelParseError("The GLB has no usable mesh geometry.");
    }
    return { object, bounds, dispose: () => disposeModel(object) };
  } catch (error) {
    disposeModel(object);
    throw error;
  }
}
