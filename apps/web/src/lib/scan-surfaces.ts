import { BufferAttribute, DoubleSide, Float32BufferAttribute, Material, Matrix3, Mesh, Texture, Vector3, type Intersection, type Object3D, type Raycaster, type Side } from "three";

/*
 * Makes phone LiDAR scans easier to read in 3D, without changing their geometry
 * (route finding still sees every triangle):
 *
 * - Wall cutaway. The scan's floor and ceiling heights are measured, and everything above a
 *   chosen height is cut away, like a dollhouse with its top sliced off:
 *     "low"     walls cut at chest height (floor + 1.3 m): reads like a floor plan;
 *     "ceiling" only the ceiling removed (just under the ceiling height);
 *     "full"    nothing cut.
 *   Heights: ARKit labels when the scan has them (`_AR_CLASSIFICATION`, GLTFLoader names it
 *   `_ar_classification`; first byte 2 floor, 3 ceiling; see ScanGeometry.swift), otherwise
 *   the most common height of upward-facing surfaces (floor) and of downward-facing ones
 *   high above it (ceiling). Cut faces are discarded in the shader and skipped when clicking.
 *   Storeys above the main floor count as "above the ceiling", so "low" and "ceiling" show
 *   the main floor; "full" shows every storey.
 *   While cutting, a wall seen from the side the scanner never saw (its back) is drawn in a
 *   flat dark colour, so walls read as clean outlines instead of see-through
 *   shells. That uses the scan's normals, which face the scanner, not the triangle winding.
 * - Photo textures get the GPU's highest anisotropic filtering, so floors and walls seen
 *   at a slant stay sharp instead of blurring.
 * - Vertex colours are camera sRGB in Path Capture's export, but glTF reads COLOR_0 as
 *   linear, which washed them out. They are converted to linear once. Applies to files
 *   written by Path Capture or by our processor (glTF-Transform).
 */

const PHONE_SCAN = /^(Path Capture|glTF-Transform)/;
const CLASSIFICATION = "_ar_classification";
const FLOOR = 2;
export const CEILING = 3;
/** Walls are cut this far above the floor in the "low" view (metres). */
export const LOW_CUT = 1.3;
/** The ceiling over the main floor is looked for this far above it (metres). */
const MIN_CEILING = 1.8, MAX_CEILING = 5.0;
/** Drawn for the back of a cut wall (final sRGB). */
const BACK_COLOR = "vec3(0.15, 0.23, 0.18)";

export type WallCut = "low" | "ceiling" | "full";

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

export interface ScanHeights {
  /** World height of the main floor. */
  floorY: number;
  /** World height of the ceiling over it, or null when the scan has none (outdoors, open top). */
  ceilingY: number | null;
  /** World height of the top of the scan (99th percentile, so stray points don't count). */
  topY: number;
}

export interface ScanSurfaces extends ScanHeights {
  /** The cut views that change something for this scan, in menu order. Empty: nothing to cut. */
  cuts: WallCut[];
  /** The view to start with: "low" indoors (a ceiling was found), else "full". */
  defaultCut: WallCut;
  setCut(cut: WallCut): void;
  /** Restores materials and raycasting (call before disposing the model). */
  dispose(): void;
}

/** Most common value, in `bin`-sized buckets. */
function mode(values: number[], bin: number): number | null {
  if (!values.length) return null;
  const counts = new Map<number, number>();
  let best = 0, bestCount = 0;
  for (const value of values) {
    const key = Math.round(value / bin);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > bestCount) { best = key; bestCount = count; }
  }
  return best * bin;
}

function quantile(values: number[], share: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(share * sorted.length)))] ?? 0;
}

/** Floor, ceiling and top heights from up to ~60k world-space samples. */
export function measureHeights(meshes: Mesh[]): ScanHeights | null {
  let total = 0;
  for (const mesh of meshes) total += mesh.geometry.getAttribute("position")?.count ?? 0;
  if (!total) return null;
  const step = Math.max(1, Math.floor(total / 60000));
  const all: number[] = [], up: number[] = [], down: number[] = [], floors: number[] = [], ceilings: number[] = [];
  const point = new Vector3(), normal = new Vector3(), toWorld = new Matrix3();
  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute("position");
    const normals = mesh.geometry.getAttribute("normal");
    const classes = mesh.geometry.getAttribute(CLASSIFICATION);
    if (!positions) continue;
    mesh.updateWorldMatrix(true, false);
    toWorld.getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < positions.count; i += step) {
      const y = point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).y;
      all.push(y);
      const label = classes?.getX(i);
      if (label === FLOOR) floors.push(y);
      else if (label === CEILING) ceilings.push(y);
      if (normals) {
        const ny = normal.fromBufferAttribute(normals, i).applyMatrix3(toWorld).normalize().y;
        if (ny > 0.8) up.push(y);
        else if (ny < -0.8) down.push(y);
      }
    }
  }
  const topY = quantile(all, 0.99);
  const floorY = mode(floors, 0.05) ?? mode(up, 0.05) ?? quantile(all, 0.02);
  // The ceiling right over the main floor (not an upper storey's), covering a good share of the scan.
  const overhead = (ceilings.length ? ceilings : down).filter((y) => y > floorY + MIN_CEILING && y < floorY + MAX_CEILING);
  const ceilingY = overhead.length > all.length * 0.01 ? mode(overhead, 0.05) : null;
  return { floorY, ceilingY, topY };
}

function patchMaterial(material: Material, cutY: { value: number }) {
  const previous = material.onBeforeCompile;
  const previousSide: Side = material.side;
  material.onBeforeCompile = (shader: ShaderLike, renderer) => {
    previous.call(material, shader as never, renderer);
    shader.uniforms.uScanCutY = cutY;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vScanWorld;\nvarying vec3 vScanNormal;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvScanWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvScanNormal = mat3(modelMatrix) * normal;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uScanCutY;\nvarying vec3 vScanWorld;\nvarying vec3 vScanNormal;")
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (vScanWorld.y > uScanCutY) discard;")
      .replace(
        "#include <dithering_fragment>",
        // Only walls (near-vertical): a floor seen from below, or one whose normals point the
        // wrong way, keeps its colour instead of turning into a dark patch.
        `#include <dithering_fragment>\nif (uScanCutY < 1.0e8 && abs(normalize(vScanNormal).y) < 0.5 && dot(vScanNormal, cameraPosition - vScanWorld) < 0.0) gl_FragColor.rgb = ${BACK_COLOR};`,
      );
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|scan-cut`;
  material.needsUpdate = true;
  return {
    /** Cutting shows both sides of each surface; uncut keeps the file's own setting. */
    setCutting(cutting: boolean) {
      const side = cutting ? DoubleSide : previousSide;
      if (material.side !== side) { material.side = side; material.needsUpdate = true; }
    },
    restore() {
      material.onBeforeCompile = previous;
      material.customProgramCacheKey = previousKey;
      material.side = previousSide;
      material.needsUpdate = true;
    },
  };
}

export function prepareScanSurfaces(roots: Object3D[], maxAnisotropy: number): ScanSurfaces {
  // The uniform holds a large finite number for "no cut": GLSL has no infinity literal.
  const NO_CUT = 1.0e9;
  const cutY = { value: NO_CUT };
  const restores: (() => void)[] = [];
  const sides: ((cutting: boolean) => void)[] = [];
  const patched = new Set<Material>();
  const meshes: Mesh[] = [];

  for (const root of roots) {
    const phoneScan = PHONE_SCAN.test(String(root.userData.generator ?? ""));
    root.updateMatrixWorld(true);
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      meshes.push(object);
      if (phoneScan) linearizeVertexColors(object);
      const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof Texture && value.anisotropy < maxAnisotropy) {
            value.anisotropy = maxAnisotropy;
            value.needsUpdate = true;
          }
        }
        if (patched.has(material)) continue;
        patched.add(material);
        const patch = patchMaterial(material, cutY);
        sides.push(patch.setCutting);
        restores.push(patch.restore);
      }
      // Clicks pass through cut-away faces to whatever is below them.
      const raycast = object.raycast;
      object.raycast = function (raycaster: Raycaster, intersects: Intersection[]) {
        if (cutY.value >= NO_CUT) return raycast.call(this, raycaster, intersects);
        const hits: Intersection[] = [];
        raycast.call(this, raycaster, hits);
        for (const hit of hits) if (hit.point.y <= cutY.value) intersects.push(hit);
      };
      restores.push(() => { object.raycast = raycast; });
    });
  }

  const heights = measureHeights(meshes) ?? { floorY: 0, ceilingY: null, topY: 0 };
  const lowY = heights.floorY + LOW_CUT;
  const ceilingCutY = heights.ceilingY === null ? null : heights.ceilingY - 0.15;
  const cuts: WallCut[] = [];
  if (heights.topY > lowY + 0.2) cuts.push("low");
  if (ceilingCutY !== null && ceilingCutY > lowY) cuts.push("ceiling");
  if (cuts.length) cuts.push("full");
  const defaultCut: WallCut = heights.ceilingY !== null && cuts.includes("low") ? "low" : "full";

  const surfaces: ScanSurfaces = {
    ...heights,
    cuts,
    defaultCut,
    setCut(cut) {
      cutY.value = cut === "low" ? lowY : cut === "ceiling" && ceilingCutY !== null ? ceilingCutY : NO_CUT;
      const cutting = cutY.value < NO_CUT;
      for (const set of sides) set(cutting);
    },
    dispose() {
      for (const restore of restores.splice(0)) restore();
    },
  };
  surfaces.setCut(defaultCut);
  return surfaces;
}
