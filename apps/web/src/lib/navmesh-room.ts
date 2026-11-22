import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from "three";

/** Synthetic metres/+Y-up room. Wall x=0, doorway z=1..3, headroom 2.4m. */
export function createRoom(options: { closed?: boolean; doorwayHeight?: number; threshold?: number } = {}) {
  const group = new Group();
  function box(size: [number, number, number], position: [number, number, number], color: string) {
    const mesh = new Mesh(new BoxGeometry(...size), new MeshStandardMaterial({ color }));
    mesh.position.set(...position); group.add(mesh);
  }
  box([12, 0.2, 10], [0, -0.1, 0], "#384c43");
  box([0.3, 3, 6], [0, 1.5, -2], "#d2c6ac");
  box([0.3, 3, 2], [0, 1.5, 4], "#d2c6ac");
  const headroom = options.doorwayHeight ?? 2.4;
  box([0.3, 3 - headroom, 2], [0, (3 + headroom) / 2, 2], "#d2c6ac");
  box([1, 1.5, 1.2], [-2.4, 0.75, 0.5], "#8d9eac");
  if (options.closed) box([0.3, 3, 2], [0, 1.5, 2], "#d2c6ac");
  if (options.threshold) box([0.5, options.threshold, 2], [0, options.threshold / 2, 2], "#ad8e67");
  return group;
}
export function disposeRoom(group: Group) {
  group.traverse(object => { if (object instanceof Mesh) { object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose(); } });
}
