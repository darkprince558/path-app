import {
  Box3, BufferGeometry, CanvasTexture, Color, DirectionalLight, DoubleSide, HemisphereLight, LoadingManager,
  MathUtils, Mesh, MeshBasicMaterial, MeshStandardMaterial, NoToneMapping, PerspectiveCamera,
  Points, PointsMaterial, Scene, Sphere, SRGBColorSpace, Texture, Vector3, WebGLRenderer,
  type Material, type Object3D,
} from "three";
import { GLTFLoader, type GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { parsePointCloud } from "./src/lib/ply";
import type { CaptureView } from "./CameraCanvas";

async function bytes(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("A local reconstruction file could not be loaded.");
  return response.arrayBuffer();
}

function photoMaterial(source: Material): MeshBasicMaterial {
  const material = source as MeshStandardMaterial;
  if (!material.map) throw new Error("A mesh surface is missing its photo texture.");
  // Phone photographs already contain illumination. Show their base colour directly.
  return new MeshBasicMaterial({
    map: material.map, color: material.color, side: material.side, vertexColors: material.vertexColors,
    transparent: material.transparent, opacity: material.opacity, alphaTest: material.alphaTest,
  });
}

function isPlaneFill(mesh: Mesh, parser: GLTFParser) {
  // GLTFLoader sanitizes object names. Read original names on the mesh and its
  // parent nodes so multi-primitive meshes and groups are identified correctly.
  for (let object: Object3D | null = mesh; object; object = object.parent) {
    const ref = parser.associations.get(object);
    if (ref?.nodes !== undefined && parser.json.nodes[ref.nodes].name === "Plane fills") return true;
    if (ref?.meshes !== undefined && parser.json.meshes[ref.meshes].name === "Plane fills") return true;
  }
  return false;
}

async function loadSurface(meshData: ArrayBuffer) {
  const manager = new LoadingManager();
  manager.setURLModifier(url => {
    if (url.startsWith("blob:") || url.startsWith("data:")) return url;
    throw new Error("The mesh must contain its own textures and buffers.");
  });
  const { scene, parser } = await new GLTFLoader(manager).parseAsync(meshData, "");
  const originals = new Set<Material>();
  const textures = new Set<Texture>();
  const images = new Set<ImageBitmap>();
  const geometries = new Set<BufferGeometry>();
  const photos = new Map<Material, MeshBasicMaterial>();
  const surfaces: { mesh: Mesh; photo: Material | Material[]; fill: boolean }[] = [];
  let triangles = 0;
  let fillTriangles = 0;
  function dispose() {
    geometries.forEach(g => g.dispose());
    originals.forEach(m => m.dispose());
    photos.forEach(m => m.dispose());
    textures.forEach(t => t.dispose());
    images.forEach(img => img.close());
  }
  try {
    scene.traverse((item: Object3D) => {
      if (!(item instanceof Mesh)) return;
      const geometry = item.geometry;
      geometries.add(geometry);
      const materials = Array.isArray(item.material) ? item.material : [item.material];
      for (const m of materials) {
        originals.add(m);
        for (const tex of Object.values(m)) {
          if (!(tex instanceof Texture)) continue;
          textures.add(tex);
          if (typeof ImageBitmap !== "undefined" && tex.image instanceof ImageBitmap) images.add(tex.image);
        }
        if (!photos.has(m)) photos.set(m, photoMaterial(m));
      }
      if (!geometry.getAttribute("uv") || !geometry.getAttribute("position")) {
        throw new Error("A mesh surface is missing positions or texture coordinates.");
      }
      const count = (geometry.index ?? geometry.getAttribute("position")).count / 3;
      const fill = isPlaneFill(item, parser);
      if (fill) fillTriangles += count;
      triangles += count;
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      const photo = Array.isArray(item.material) ? materials.map(m => photos.get(m)!) : photos.get(materials[0]!)!;
      surfaces.push({ mesh: item, photo, fill });
      item.material = photo;
    });
    if (!surfaces.length || !Number.isInteger(triangles) || !triangles) throw new Error("Empty triangle mesh.");
    return { scene, surfaces, triangles, fillTriangles, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

export async function loadAssets(first: string, mesh: string, planes: boolean, signal: AbortSignal) {
  const [firstData, meshData] = await Promise.all([bytes(first, signal), bytes(mesh, signal)]);
  const right = await loadSurface(meshData);
  try {
    const baseline = planes ? await loadSurface(firstData) : undefined;
    const scan = baseline ? undefined : parsePointCloud(firstData);
    return {
      right, baseline, scan,
      dispose() { right.dispose(); baseline?.dispose(); scan?.geometry.dispose(); },
    };
  } catch (error) {
    right.dispose();
    throw error;
  }
}

export type Assets = Awaited<ReturnType<typeof loadAssets>>;

export function createStage(canvas: HTMLCanvasElement, assets: Assets, initialView?: CaptureView) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(new Color("#121c16"));
  renderer.setScissorTest(true);
  const leftScene = new Scene();
  const rightScene = new Scene();
  const scan = assets.scan;
  const bounds = new Box3().setFromObject(assets.right.scene).getBoundingSphere(new Sphere());
  const worldSize = scan ? MathUtils.clamp(scan.bounds.radius / Math.sqrt(scan.count) * .7, .008, .3) : 0;
  let dots: PointsMaterial | undefined;
  if (scan) {
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = 32;
    const context = sprite.getContext("2d")!;
    context.fillStyle = "white";
    context.beginPath();
    context.arc(16, 16, 15.5, 0, 2 * Math.PI);
    context.fill();
    dots = new PointsMaterial({
      size: worldSize, map: new CanvasTexture(sprite), alphaTest: .5,
      vertexColors: scan.hasColor, color: scan.hasColor ? 0xffffff : 0xa9c4ae, sizeAttenuation: true,
    });
    leftScene.add(new Points(scan.geometry, dots));
    bounds.union(scan.bounds);
  } else if (assets.baseline) {
    leftScene.add(assets.baseline.scene);
    bounds.union(new Box3().setFromObject(assets.baseline.scene).getBoundingSphere(new Sphere()));
  }
  rightScene.add(assets.right.scene);
  for (const scene of [leftScene, rightScene]) {
    const light = new DirectionalLight(0xfff2de, 2.5);
    light.position.set(3, 5, 4);
    scene.add(new HemisphereLight(0xf0f5ff, 0x686050, 1.65), light);
  }
  const clay = new MeshStandardMaterial({ color: 0xcac6b8, roughness: 1, metalness: 0, side: DoubleSide });
  const fillColor = new MeshBasicMaterial({ color: 0xff8d38, side: DoubleSide });
  const camera = new PerspectiveCamera(55, 1, Math.max(bounds.radius / 2000, .0001), bounds.radius * 80);
  let controls: OrbitControls;
  // Draw each scene into an equal viewport using the very same projection and camera.
  let stacked = false;
  let w = 1, h = 1;
  function render() {
    function draw(scene: Scene, x: number, y: number) {
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      renderer.render(scene, camera);
    }
    draw(leftScene, 0, stacked ? h : 0);
    draw(rightScene, stacked ? 0 : w, 0);
  }
  function resize() {
    const stage = canvas.parentElement!;
    stacked = getComputedStyle(stage).getPropertyValue("--stacked").trim() === "1";
    w = Math.max(1, stage.clientWidth / (stacked ? 1 : 2));
    h = Math.max(1, stage.clientHeight / (stacked ? 2 : 1));
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
    // Three scales point sprites with the full framebuffer height.
    if (dots) dots.size = worldSize * h / stage.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }
  function setView(view?: CaptureView) {
    controls?.dispose();
    let target = bounds.center;
    if (view) {
      camera.position.fromArray(view.position);
      camera.up.fromArray(view.up).normalize();
      target = new Vector3().fromArray(view.target);
    } else {
      const v = MathUtils.degToRad(camera.fov) / 2;
      const distance = bounds.radius / Math.sin(Math.min(v, Math.atan(Math.tan(v) * camera.aspect))) * .95;
      camera.up.set(0, 1, 0);
      camera.position.copy(bounds.center).addScaledVector(new Vector3(0, .4, .92).normalize(), distance);
    }
    // OrbitControls records the camera's up vector when constructed. Recreate it
    // when returning to a capture viewpoint, including one with real phone roll.
    controls = new OrbitControls(camera, canvas);
    controls.target.copy(target);
    const distance = camera.position.distanceTo(target);
    controls.minDistance = Math.min(bounds.radius / 300, distance / 20);
    controls.maxDistance = Math.max(bounds.radius * 12, distance * 2);
    controls.rotateSpeed = .7;
    controls.zoomSpeed = .9;
    controls.addEventListener("change", render);
    controls.update();
    render();
  }
  resize();
  setView(initialView);
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement!);
  return {
    setView,
    setAppearance(solid: boolean, highlight: boolean) {
      for (const s of assets.baseline?.surfaces ?? []) s.mesh.material = solid ? clay : s.photo;
      for (const s of assets.right.surfaces) {
        s.mesh.material = highlight && s.fill ? fillColor : solid ? clay : s.photo;
      }
      render();
    },
    dispose() {
      observer.disconnect();
      controls.dispose();
      if (assets.baseline) leftScene.remove(assets.baseline.scene);
      rightScene.remove(assets.right.scene);
      dots?.map?.dispose();
      dots?.dispose();
      fillColor.dispose();
      clay.dispose();
      renderer.dispose();
    },
  };
}
