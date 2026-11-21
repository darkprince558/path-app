import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from "three";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";

/** Above this many points, keep an evenly spaced subset so phones stay interactive. */
export const MAX_POINTS = 600_000;

export class ScanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanParseError";
  }
}

export interface PointScan {
  geometry: BufferGeometry;
  /** Points in the file before any downsampling. */
  sourceCount: number;
  /** Points actually rendered. */
  count: number;
  hasColor: boolean;
  bounds: Sphere;
}

function downsample(geometry: BufferGeometry, keep: number): BufferGeometry {
  const total = geometry.getAttribute("position").count;
  const stride = total / keep;
  const out = new BufferGeometry();
  for (const name of ["position", "color"] as const) {
    const source = geometry.getAttribute(name);
    if (!source) continue;
    const size = source.itemSize;
    const data = new Float32Array(keep * size);
    for (let i = 0; i < keep; i++) {
      const from = Math.floor(i * stride);
      for (let c = 0; c < size; c++) data[i * size + c] = source.array[from * size + c] ?? 0;
    }
    out.setAttribute(name, new BufferAttribute(data, size));
  }
  geometry.dispose();
  return out;
}

/**
 * Parses an ASCII or binary PLY with XYZ positions and optional uchar RGB colors.
 * PLYLoader converts the sRGB vertex colors to linear, which is what three expects.
 */
export function parsePointCloud(buffer: ArrayBuffer): PointScan {
  const header = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, 3)));
  if (header !== "ply") throw new ScanParseError("The file isn't a PLY scan (missing the “ply” header).");

  let geometry: BufferGeometry;
  try {
    geometry = new PLYLoader().parse(buffer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScanParseError(`The PLY couldn't be read: ${detail}`);
  }

  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) {
    throw new ScanParseError("The PLY has no points.");
  }
  for (let i = 0; i < position.array.length; i++) {
    if (!Number.isFinite(position.array[i])) {
      throw new ScanParseError("The PLY has coordinates that aren't finite numbers.");
    }
  }

  const sourceCount = position.count;
  if (sourceCount > MAX_POINTS) geometry = downsample(geometry, MAX_POINTS);

  geometry.computeBoundingSphere();
  const bounds = geometry.boundingSphere?.clone() ?? new Sphere(new Vector3(), 1);
  if (bounds.radius <= 0) bounds.radius = 1;

  return {
    geometry,
    sourceCount,
    count: geometry.getAttribute("position").count,
    hasColor: Boolean(geometry.getAttribute("color")),
    bounds,
  };
}
