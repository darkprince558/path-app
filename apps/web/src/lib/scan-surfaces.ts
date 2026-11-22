import { Box3, BufferAttribute, Float32BufferAttribute, Material, Matrix3, Mesh, Texture, Vector3, type Intersection, type Object3D, type Raycaster } from "three";

/*
 * Makes phone LiDAR scans easier to read in 3D, without changing their geometry
 * (route finding still sees every triangle):
 *
 * - Ceilings are hidden, so you look into rooms and corridors instead of at their lid.
 *   Labelled scans: Path Capture's ARKit mesh stores the surface type per vertex in
 *   `_AR_CLASSIFICATION` (GLTFLoader names it `_ar_classification`; first byte 0 none,
 *   1 wall, 2 floor, 3 ceiling, 4 table, 5 seat, 6 window, 7 door; see ScanGeometry.swift).
 *   Unlabelled phone scans (e.g. "Path Capture depth fusion"): a ceiling is a surface that
 *   faces down (world normal y < -0.5) in the upper half of the scan. Hidden faces are
 *   discarded in the shader and skipped when clicking, so a double-click lands on the
 *   floor, not on an invisible ceiling.
 * - Photo textures get the GPU's highest anisotropic filtering, so floors and walls seen
 *   at a slant stay sharp instead of blurring.
 * - Vertex colours are camera sRGB in Path Capture's export, but glTF reads COLOR_0 as
 *   linear, which washed them out. They are converted to linear once. Applies to files
 *   written by Path Capture or by our processor (glTF-Transform).
 */

const PHONE_SCAN = /^(Path Capture|glTF-Transform)/;
const CLASSIFICATION = "_ar_classification";
export const CEILING = 3;
/** World normal y below this counts as facing down. */
const DOWNWARD = -0.5;
/** Unlabelled ceilings must sit above this fraction of the scan's height. */
const CEILING_HEIGHT = 0.5;

/** The standard sRGB transfer curve, 0–1 in and out. */
function srgbToLinear(c: number) {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** Camera colours are sRGB; three.js expects linear vertex colours. */
function linearizeVertexColors(mesh: Mesh) {
  const color = mesh.geometry.getAttribute("color") as BufferAttribute | undefined;
  if (!color || mesh.geometry.userData.scanColorsLinear) return;
  const values = new Float32Array(color.count * color.itemSize);
  for (let i = 0; i < color.count; i++) {
    for (let c = 0; c < color.itemSize; c++) {
      const value = color.getComponent(i, c); // getComponent returns 0–1 for normalized bytes
      values[i * color.itemSize + c] = c < 3 ? srgbToLinear(value) : value;
    }
  }
  mesh.geometry.setAttribute("color", new Float32BufferAttribute(values, color.itemSize));
  mesh.geometry.userData.scanColorsLinear = true;
}

interface ShaderLike {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
}

export interface ScanSurfaces {
  /** True when there is a ceiling to hide (labelled, or found by shape). */
  hasCeiling: boolean;
  setCeilingHidden(hidden: boolean): void;
  /** Restores materials and raycasting (call before disposing the model). */
  dispose(): void;
}

type CeilingMode = "labels" | "shape";

function patchMaterial(material: Material, mode: CeilingMode, hide: { value: boolean }, ceilingY: { value: number }) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader: ShaderLike, renderer) => {
    previous.call(material, shader as never, renderer);
    shader.uniforms.uHideCeiling = hide;
    if (mode === "labels") {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\nattribute vec4 ${CLASSIFICATION};\nvarying float vScanClass;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\nvScanClass = ${CLASSIFICATION}.x;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform bool uHideCeiling;\nvarying float vScanClass;")
        .replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>\nif (uHideCeiling && abs(vScanClass - ${CEILING}.0) < 0.5) discard;`,
        );
    } else {
      shader.uniforms.uCeilingY = ceilingY;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vScanWorldY;\nvarying float vScanDownward;")
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvScanWorldY = (modelMatrix * vec4(transformed, 1.0)).y;\nvScanDownward = normalize(mat3(modelMatrix) * normal).y;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform bool uHideCeiling;\nuniform float uCeilingY;\nvarying float vScanWorldY;\nvarying float vScanDownward;")
        .replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>\nif (uHideCeiling && vScanDownward < ${DOWNWARD.toFixed(2)} && vScanWorldY > uCeilingY) discard;`,
        );
    }
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|scan-ceiling-${mode}`;
  material.needsUpdate = true;
  return () => {
    material.onBeforeCompile = previous;
    material.customProgramCacheKey = previousKey;
    material.needsUpdate = true;
  };
}

/** Counts vertices that face down above the ceiling height, in world space. */
function shapeCeilingShare(mesh: Mesh, ceilingY: number) {
  const positions = mesh.geometry.getAttribute("position");
  const normals = mesh.geometry.getAttribute("normal");
  if (!positions || !normals) return 0;
  const toWorld = new Matrix3().getNormalMatrix(mesh.matrixWorld);
  const point = new Vector3(), normal = new Vector3();
  let down = 0;
  const step = Math.max(1, Math.floor(positions.count / 50000)); // sample big meshes
  let seen = 0;
  for (let i = 0; i < positions.count; i += step) {
    seen++;
    normal.fromBufferAttribute(normals, i).applyMatrix3(toWorld).normalize();
    if (normal.y >= DOWNWARD) continue;
    point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
    if (point.y > ceilingY) down++;
  }
  return seen ? down / seen : 0;
}

export function prepareScanSurfaces(roots: Object3D[], maxAnisotropy: number): ScanSurfaces {
  const hide = { value: true };
  const restores: (() => void)[] = [];
  const patched = new Set<Material>();
  let hasCeiling = false;

  for (const root of roots) {
    const phoneScan = PHONE_SCAN.test(String(root.userData.generator ?? ""));
    root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(root);
    const ceilingY = { value: bounds.min.y + CEILING_HEIGHT * (bounds.max.y - bounds.min.y) };

    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      if (phoneScan) linearizeVertexColors(object);
      const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material];

      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof Texture && value.anisotropy < maxAnisotropy) {
            value.anisotropy = maxAnisotropy;
            value.needsUpdate = true;
          }
        }
      }

      const classes = object.geometry.getAttribute(CLASSIFICATION) as BufferAttribute | undefined;
      let mode: CeilingMode | null = null;
      if (classes) {
        for (let i = 0; i < classes.count && !mode; i++) if (classes.getX(i) === CEILING) mode = "labels";
      } else if (phoneScan && shapeCeilingShare(object, ceilingY.value) > 0.005) {
        mode = "shape";
      }
      if (!mode) return;
      hasCeiling = true;
      const ceilingMode = mode;

      for (const material of materials) {
        if (patched.has(material)) continue;
        patched.add(material);
        restores.push(patchMaterial(material, ceilingMode, hide, ceilingY));
      }

      // Clicks pass through hidden ceiling faces to whatever is behind them.
      const raycast = object.raycast;
      const normalToWorld = new Matrix3();
      const faceNormal = new Vector3();
      const vertexNormal = new Vector3();
      object.raycast = function (raycaster: Raycaster, intersects: Intersection[]) {
        if (!hide.value) return raycast.call(this, raycaster, intersects);
        const hits: Intersection[] = [];
        raycast.call(this, raycaster, hits);
        normalToWorld.getNormalMatrix(object.matrixWorld);
        for (const hit of hits) {
          const face = hit.face;
          if (face && ceilingMode === "labels" && classes &&
              classes.getX(face.a) === CEILING && classes.getX(face.b) === CEILING && classes.getX(face.c) === CEILING) continue;
          // Same test as the shader: the surface's own (vertex) normals, not the triangle winding.
          const normals = object.geometry.getAttribute("normal");
          if (face && ceilingMode === "shape" && normals && hit.point.y > ceilingY.value &&
              faceNormal.fromBufferAttribute(normals, face.a).add(vertexNormal.fromBufferAttribute(normals, face.b))
                .add(vertexNormal.fromBufferAttribute(normals, face.c)).applyMatrix3(normalToWorld).normalize().y < DOWNWARD) continue;
          intersects.push(hit);
        }
      };
      restores.push(() => { object.raycast = raycast; });
    });
  }

  return {
    hasCeiling,
    setCeilingHidden(hidden) {
      hide.value = hidden;
    },
    dispose() {
      for (const restore of restores.splice(0)) restore();
    },
  };
}
