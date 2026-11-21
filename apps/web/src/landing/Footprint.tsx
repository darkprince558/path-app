import { useLayoutEffect, useMemo, useRef, useState } from "react";

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

/** Seconds between one step and the next on the looping trail. */
const STEP_SECONDS = 0.38;
/** Pause after the walker leaves before the next one starts. */
const LOOP_PAUSE_SECONDS = 1.6;

/** SVG units per CSS pixel of height for the walking trail (the trail is drawn 140 units tall). */
const TRAIL_UNITS_TALL = 140;

/** A gentle wave from just off the left edge to just off the right edge of a `width`-unit-wide box. */
function waveAcross(width: number): string {
  const y = 70;
  const lift = 42;
  const segment = 560;
  const count = Math.max(1, Math.ceil((width + 80) / segment));
  const step = (width + 80) / count;
  let d = `M-40 ${y}`;
  for (let i = 0; i < count; i++) {
    const x0 = -40 + i * step;
    const up = i % 2 === 0 ? -lift : lift;
    d += ` C ${x0 + step * 0.35} ${y + up}, ${x0 + step * 0.65} ${y + up}, ${x0 + step} ${y}`;
  }
  return d;
}

/**
 * Footprints that keep walking across the full width, one step at a time, on a
 * loop. The trail is drawn to the box's measured width, so on any screen a walker
 * crosses edge to edge. Each print fades in when it's "stepped on" and fades out
 * behind the walker. With Reduce motion the whole trail just sits there, faint.
 */
export function WalkingPrints({ reduce, className, color = "#2F4A3A" }: { reduce: boolean; className?: string; color?: string }) {
  const box = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(1920);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.height > 0) setWidth(Math.round((rect.width / rect.height) * TRAIL_UNITS_TALL));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const prints = useMemo(() => printsAlong(waveAcross(width), 64, 12, 10), [width]);
  const period = prints.length * STEP_SECONDS + LOOP_PAUSE_SECONDS;
  return (
    <svg ref={box} viewBox={`0 0 ${width} ${TRAIL_UNITS_TALL}`} className={className} aria-hidden="true">
      <g fill={color}>
        {prints.map((p, i) => (
          <g key={i} transform={`translate(${p.x} ${p.y}) rotate(${p.angle}) scale(${p.left ? -2.2 : 2.2} 2.2)`}>
            {reduce ? (
              <g opacity="0.3">
                <FootprintShape />
              </g>
            ) : (
              <g className="print-step" style={{ animationDuration: `${period}s`, animationDelay: `${i * STEP_SECONDS}s` }}>
                <FootprintShape />
              </g>
            )}
          </g>
        ))}
      </g>
    </svg>
  );
}
