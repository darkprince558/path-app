import { BufferAttribute, Float32BufferAttribute, Material, Mesh, Texture, type Intersection, type Object3D, type Raycaster } from "three";

/*
 * Makes phone LiDAR scans easier to read in 3D, without changing their geometry
 * (route finding still sees every triangle):
 *
 * - Ceilings are hidden, so you look into rooms and corridors instead of at their lid.
 *   Path Capture stores ARKit's surface type per vertex in `_AR_CLASSIFICATION`
 *   (GLTFLoader names it `_ar_classification`; first byte 0 none, 1 wall, 2 floor,
 *   3 ceiling, 4 table, 5 seat, 6 window, 7 door; see ScanGeometry.swift). Hidden faces
 *   are discarded in the shader and skipped when clicking, so a double-click lands on
 *   the floor, not on an invisible ceiling. Scans without the attribute are unchanged.
 * - Photo textures get the GPU's highest anisotropic filtering, so floors and walls seen
 *   at a slant stay sharp instead of blurring.
 * - Vertex colours (faces no photo covered) are camera sRGB in Path Capture's export, but
 *   glTF reads COLOR_0 as linear, which washed them out. They are converted to linear once.
 *   Applies to files written by Path Capture or by our processor (glTF-Transform).
 */

const PHONE_SCAN = /^(Path Capture|glTF-Transform)/;

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

const CLASSIFICATION = "_ar_classification";
export const CEILING = 3;

interface ShaderLike {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
}

export interface ScanSurfaces {
  /** True when at least one face is labelled as ceiling. */
  hasCeiling: boolean;
  setCeilingHidden(hidden: boolean): void;
  /** Restores materials and raycasting (call before disposing the model). */
  dispose(): void;
}

function patchMaterial(material: Material, hide: { value: boolean }) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader: ShaderLike, renderer) => {
    previous.call(material, shader as never, renderer);
    shader.uniforms.uHideCeiling = hide;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute vec4 ${CLASSIFICATION};\nvarying float vScanClass;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvScanClass = ${CLASSIFICATION}.x;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform bool uHideCeiling;\nvarying float vScanClass;")
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>\nif (uHideCeiling && abs(vScanClass - ${CEILING}.0) < 0.5) discard;`,
      );
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|scan-ceiling`;
  material.needsUpdate = true;
  return () => {
    material.onBeforeCompile = previous;
    material.customProgramCacheKey = previousKey;
    material.needsUpdate = true;
  };
}

function isCeilingFace(classes: BufferAttribute, a: number, b: number, c: number) {
  return classes.getX(a) === CEILING && classes.getX(b) === CEILING && classes.getX(c) === CEILING;
}

export function prepareScanSurfaces(roots: Object3D[], maxAnisotropy: number): ScanSurfaces {
  const hide = { value: true };
  const restores: (() => void)[] = [];
  const patched = new Set<Material>();
  let hasCeiling = false;

  for (const root of roots) {
    const phoneScan = PHONE_SCAN.test(String(root.userData.generator ?? ""));
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
      if (!classes) return;
      let ceiling = false;
      for (let i = 0; i < classes.count && !ceiling; i++) ceiling = classes.getX(i) === CEILING;
      if (!ceiling) return;
      hasCeiling = true;

      for (const material of materials) {
        if (patched.has(material)) continue;
        patched.add(material);
        restores.push(patchMaterial(material, hide));
      }

      // Clicks pass through hidden ceiling faces to whatever is behind them.
      const raycast = object.raycast;
      object.raycast = function (raycaster: Raycaster, intersects: Intersection[]) {
        if (!hide.value) return raycast.call(this, raycaster, intersects);
        const hits: Intersection[] = [];
        raycast.call(this, raycaster, hits);
        for (const hit of hits) {
          if (hit.face && isCeilingFace(classes, hit.face.a, hit.face.b, hit.face.c)) continue;
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
