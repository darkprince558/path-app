/** One footprint, pointing up (−y), about 14 × 26 units. Toes, sole and heel. */
export function FootprintShape() {
  return (
    <g>
      <ellipse cx="0" cy="-2" rx="4.6" ry="6.6" />
      <ellipse cx="0" cy="8" rx="3.4" ry="3.9" />
      <circle cx="-3.6" cy="-10.2" r="1.35" />
      <circle cx="-1.2" cy="-11.4" r="1.45" />
      <circle cx="1.4" cy="-11.2" r="1.35" />
      <circle cx="3.6" cy="-9.8" r="1.2" />
    </g>
  );
}

export interface PrintPlacement {
  x: number;
  y: number;
  /** Degrees, 0 = pointing up. */
  angle: number;
  left: boolean;
}

/**
 * Places alternating left and right prints along an SVG path element.
 * `stride` is the distance between prints in path units.
 */
export function placePrints(path: SVGPathElement, stride: number, offset = 7, margin = 0): PrintPlacement[] {
  const total = path.getTotalLength();
  const prints: PrintPlacement[] = [];
  for (let d = margin, i = 0; d <= total - margin; d += stride, i++) {
    const p = path.getPointAtLength(d);
    const q = path.getPointAtLength(Math.min(total, d + 1));
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const left = i % 2 === 0;
    const side = left ? -1 : 1;
    // Normal to the path, pointing to the walker's right.
    const nx = -dy / len;
    const ny = dx / len;
    prints.push({
      x: p.x + nx * offset * side,
      y: p.y + ny * offset * side,
      angle: (Math.atan2(dy, dx) * 180) / Math.PI + 90,
      left,
    });
  }
  return prints;
}

/** Same as placePrints, from path data. The path is measured off-screen, so this works during render. */
export function printsAlong(d: string, stride: number, offset = 7, margin = 0): PrintPlacement[] {
  if (typeof document === "undefined") return [];
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  return placePrints(path, stride, offset, margin);
}
