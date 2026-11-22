import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useReducedMotion } from "../lib/preferences";
import { Container } from "./shared";

/*
 * "Under the hood": for people curious about the tech. One small room (the corner of
 * a hallway with a door) goes through every real stage, from laser dots to a route.
 * The player looks like the one in "The problem": story bars on top, a dark screen,
 * a caption bar with the stage and its tech under it, and a Pause button. The stages
 * are described in a list beside it (laptop) or under it (phone; the player sticks
 * under the top bar). It moves on by itself while mostly in view, pauses while
 * keyboard focus is inside or with the Pause button, and with Reduce motion you pick.
 *
 * What each stage says is what the code does today:
 *   Measure    apps/capture/PathCapture/CaptureController.swift (sceneDepth + confidence, colour from the camera)
 *   Connect    CaptureController: sceneReconstruction = .meshWithClassification
 *   Paint      PathCapture/ScanGeometry.swift: each triangle takes the photo that saw it largest and most central
 *   Clean up   tools/scan_fill_holes.py (Open3D) + gltf-transform meshopt (apps/web/README.md)
 *   Upload     services/api + apps/capture/processor (sizes, SHA-256, half-triangle phone copy)
 *   Route      SpaceViewer (three.js, low-wall cutaway) + lib/navmesh.ts (Recast, WebAssembly)
 */

interface Stage {
  title: string;
  line: string;
  /** The technical names, for people who want to look them up. */
  tech: string;
}

const STAGES: Stage[] = [
  {
    title: "Measure",
    line: "The iPhone's LiDAR sensor times light bouncing back, giving a distance for every pixel. Shaky readings are dropped and each dot takes its colour from the camera.",
    tech: "ARKit scene depth + confidence map",
  },
  {
    title: "Connect the dots",
    line: "The dots are stitched into a surface of triangles, and each triangle is labelled: floor, wall, door, seat.",
    tech: "ARKit scene reconstruction",
  },
  {
    title: "Paint with photos",
    line: "Each triangle picks the photo that saw it most squarely and wears it like a sticker. Spots no photo caught borrow colour from nearby dots.",
    tech: "Projected UVs → glTF (.glb)",
  },
  {
    title: "Clean up",
    line: "Floating junk (dust, reflections, people walking by) is removed, small holes are filled and soft shadows are baked into corners. One hallway shrank from 36 MB to 3.9 MB.",
    tech: "Open3D · ambient occlusion · meshopt",
  },
  {
    title: "Upload and check",
    line: "The scan goes to our server. App uploads are checked file by file, and a lighter copy with about half the triangles is made for phones.",
    tech: "Next.js API on Vultr · SHA-256",
  },
  {
    title: "Draw and route",
    line: "Your browser draws the map and cuts the walls low so you can see in. It works out where a person can walk and the shortest way there.",
    tech: "three.js · Recast NavMesh (WebAssembly)",
  },
];

/** Seconds each stage plays before the next. */
const SECONDS = 5;

/* ------------------------------------------------------------ the room */
/* Metres: x along the right wall (0–5), z along the left wall (0–5), y up. */

const W = 400;
const H = 290;
const project = (x: number, y: number, z: number): [number, number] => [200 + (x - z) * 27.7, 122 + (x + z) * 16 - y * 32];
const pts = (list: [number, number][]) => list.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");

/** Same "random" numbers every time, so the room never changes. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Surface = "floor" | "left" | "right";
type RGB = [number, number, number];

const FLOOR: RGB = [125, 116, 102];
const WALL: RGB = [207, 198, 174];
const DOOR: RGB = [236, 172, 58];
const POSTER: RGB = [127, 165, 138];
const ROW = 0.65; // wall rows; two rows ≈ the viewer's 1.3 m low-wall cut

/** World position of (u, v) on a surface. */
function at(surface: Surface, u: number, v: number): [number, number, number] {
  if (surface === "floor") return [u, 0, v];
  if (surface === "left") return [0, v, u];
  return [u, v, 0];
}

/** What a camera would see at (u, v): wall paint, the door, a poster, the floor. */
function colorAt(surface: Surface, u: number, v: number): RGB {
  if (surface === "floor") return FLOOR;
  if (surface === "right" && u > 3 && u < 4 && v < 2) return DOOR;
  if (surface === "left" && u > 1.6 && u < 2.6 && v > 0.8 && v < 1.6) return POSTER;
  return WALL;
}

/** Baked soft shadow: darker into corners and along the floor's edges. */
function shadeAt(surface: Surface, u: number, v: number): number {
  const near = (d: number, depth: number, reach: number) => depth * Math.exp(-Math.max(d, 0) / reach);
  if (surface === "floor") return 1 - Math.max(near(u, 0.4, 0.5), near(v, 0.4, 0.5));
  return 1 - Math.max(near(v, 0.35, 0.45), near(u, 0.3, 0.45));
}

const rgb = ([r, g, b]: RGB, k = 1) => `rgb(${Math.round(r * k)} ${Math.round(g * k)} ${Math.round(b * k)})`;

interface Tri {
  points: string;
  color: RGB;
  shade: number;
  jitter: number;
  /** Order the photo patches fill in. */
  patch: number;
  /** Above the low-wall cut. */
  high: boolean;
}

interface Dot {
  x: number;
  y: number;
  color: string;
  delay: number;
}

function buildRoom() {
  const rand = random(404);
  const tris: Tri[] = [];
  const dots: Dot[] = [];
  const surfaces: { surface: Surface; cols: number; rows: number; du: number; dv: number }[] = [
    { surface: "left", cols: 5, rows: 4, du: 1, dv: ROW },
    { surface: "right", cols: 5, rows: 4, du: 1, dv: ROW },
    { surface: "floor", cols: 5, rows: 5, du: 1, dv: 1 },
  ];
  surfaces.forEach(({ surface, cols, rows, du, dv }, s) => {
    // Grid corners, nudged a little like a real reconstruction (edges stay straight).
    const grid: [number, number][][] = [];
    for (let i = 0; i <= cols; i++) {
      grid[i] = [];
      for (let j = 0; j <= rows; j++) {
        const nudge = (edge: boolean) => (edge ? 0 : (rand() - 0.5) * 0.28);
        const u = i * du + nudge(i === 0 || i === cols);
        const v = j * dv + nudge(j === 0 || j === rows) * (dv / du);
        const [x, y, z] = at(surface, u, v);
        grid[i]![j] = project(x, y, z);
      }
    }
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const a = grid[i]![j]!, b = grid[i + 1]![j]!, c = grid[i + 1]![j + 1]!, d = grid[i]![j + 1]!;
        const u = (i + 0.5) * du, v = (j + 0.5) * dv;
        const base = { color: colorAt(surface, u, v), shade: shadeAt(surface, u, v), patch: s * 4 + Math.floor(i / 2) + Math.floor(j / 2), high: surface !== "floor" && j >= 2 };
        tris.push({ ...base, points: pts([a, b, c]), jitter: 0.9 + rand() * 0.18 });
        tris.push({ ...base, points: pts([a, c, d]), jitter: 0.9 + rand() * 0.18 });
      }
    }
    // Depth dots scattered over the surface.
    const count = surface === "floor" ? 300 : 200;
    for (let n = 0; n < count; n++) {
      const u = rand() * cols * du, v = rand() * rows * dv;
      const [x, y, z] = at(surface, u, v);
      const [sx, sy] = project(x, y, z);
      dots.push({ x: sx, y: sy, color: rgb(colorAt(surface, u, v), 0.85 + rand() * 0.3), delay: (sx / W) * 1.4 + rand() * 0.3 });
    }
  });
  // Junk: stray readings floating in the air (reflections, someone walking past).
  const junk: Dot[] = [];
  for (let n = 0; n < 26; n++) {
    const [sx, sy] = project(0.8 + rand() * 3.6, 0.3 + rand() * 1.6, 0.8 + rand() * 3.6);
    junk.push({ x: sx, y: sy, color: rand() > 0.5 ? "#A9C4AE" : "#D6CEB8", delay: rand() * 1.6 });
  }
  return { tris, dots, junk };
}

/** Floor a person can use: the floor kept 0.3 m (one body radius) away from the walls. */
const WALKABLE = pts([project(0.3, 0, 0.3), project(5, 0, 0.3), project(5, 0, 5), project(0.3, 0, 5)]);
const ROUTE = pts([project(1.2, 0, 4.5), project(3.5, 0, 3.1), project(3.5, 0, 0.55)]);
const START = project(1.2, 0, 4.5);
const END = project(3.5, 0, 0.55);

/* ------------------------------------------------------------ helpers */

/** An HTML label over the screen, placed in the room's 400 × 290 units. */
function Label({ x, y, show, delay = 0, children, tone = "glass" }: { x: number; y: number; show: boolean; delay?: number; children: ReactNode; tone?: "glass" | "paper" | "coral" }) {
  const tones = { glass: "bg-[#1B2A21]/85 text-paper ring-1 ring-sage/30 backdrop-blur", paper: "bg-paper text-ink", coral: "bg-coral text-ink" };
  return (
    <span
      className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full px-2.5 py-1 font-mono text-[0.65rem] font-bold whitespace-nowrap shadow-lg transition-[opacity,scale] duration-500 sm:text-xs ${tones[tone]} ${
        show ? "scale-100 opacity-100" : "scale-90 opacity-0"
      }`}
      style={{ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%`, transitionDelay: show ? `${delay}s` : "0s" }}
    >
      {children}
    </span>
  );
}

function Room({ stage, run }: { stage: number; run: number }) {
  const room = useMemo(buildRoom, []);
  const meshed = stage >= 1;
  const painted = stage >= 2;
  const cleaned = stage >= 3;
  const routed = stage >= 5;
  const [lx, ly] = project(0, 1.1, 0.9);
  const [rx, ry] = project(4.3, 1.5, 0);
  const [dx, dy] = project(3.5, 1.1, 0);
  const [fx, fy] = project(3.2, 0, 3.6);

  return (
    <div className="relative aspect-[400/290]">
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full" aria-hidden="true">
        {/* Triangles: wire first, then painted, then shaded. */}
        <g strokeLinejoin="round">
          {room.tris.map((t, i) => {
            const fill = painted ? rgb(t.color, t.jitter * (cleaned ? t.shade : 1)) : "transparent";
            const style: CSSProperties = {
              transitionProperty: "fill, stroke, opacity",
              transitionDuration: "600ms",
              transitionDelay: stage === 2 ? `${t.patch * 0.12}s` : "0s",
              opacity: routed && t.high ? 0 : meshed ? 1 : 0,
            };
            return <polygon key={i} points={t.points} fill={fill} stroke={painted ? fill : "#A9C4AE"} strokeOpacity={painted ? 1 : 0.55} strokeWidth={painted ? 0.6 : 0.7} style={style} />;
          })}
        </g>

        {/* Depth dots. They replay their sweep each time Measure starts. */}
        <g key={stage === 0 ? `dots-${run}` : "dots"} className="transition-opacity duration-500" style={{ opacity: painted ? 0 : meshed ? 0.45 : 1 }}>
          {room.dots.map((d, i) => (
            <circle key={i} className={stage === 0 ? "pipe-dot" : undefined} cx={d.x} cy={d.y} r={meshed ? 0.9 : 1.25} fill={d.color} style={{ animationDelay: `${d.delay}s` }} />
          ))}
        </g>
        <g className="transition-opacity duration-700" style={{ opacity: cleaned ? 0 : 1 }}>
          {room.junk.map((d, i) => (
            <circle key={i} className={stage === 0 ? "pipe-dot" : undefined} cx={d.x} cy={d.y} r="1.5" fill={d.color} style={{ animationDelay: `${d.delay}s` }} />
          ))}
        </g>

        {/* Where a person can walk, and the route over it. */}
        <g className="transition-opacity duration-700" style={{ opacity: routed ? 1 : 0, transitionDelay: routed ? "0.5s" : "0s" }}>
          <polygon points={WALKABLE} fill="#A9C4AE" fillOpacity="0.28" stroke="#A9C4AE" strokeOpacity="0.8" strokeWidth="1" strokeDasharray="3 3" />
          <polyline points={ROUTE} className="tour-route" fill="none" stroke="#F48057" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="0.1 6" />
          <circle cx={START[0]} cy={START[1]} r="5" fill="#F3EBD0" stroke="#121C16" strokeWidth="2" />
          <circle cx={END[0]} cy={END[1]} r="6" fill="#F48057" stroke="#121C16" strokeWidth="2" />
        </g>
      </svg>

      <Label x={lx} y={ly} show={stage === 1} delay={0.5}>wall</Label>
      <Label x={dx} y={dy} show={stage === 1} delay={0.7}>door</Label>
      <Label x={fx} y={fy} show={stage === 1} delay={0.9}>floor</Label>
      <Label x={200} y={268} show={stage === 3} delay={0.6} tone="paper">36 MB → 3.9 MB</Label>
      <Label x={rx} y={ry - 26} show={stage === 4} delay={0.2}>size ✓</Label>
      <Label x={rx} y={ry} show={stage === 4} delay={0.5}>SHA-256 ✓</Label>
      <Label x={rx} y={ry + 26} show={stage === 4} delay={0.8}>phone copy · ½ triangles</Label>
      <Label x={END[0] + 6} y={END[1] - 22} show={routed} delay={1.1} tone="coral">Room 204</Label>
    </div>
  );
}

/* ------------------------------------------------------------ section */

export default function Pipeline() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);
  const [run, setRun] = useState(0);
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const player = useRef<HTMLDivElement>(null);

  // Play only while the player is mostly in view.
  useEffect(() => {
    const element = player.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible((entry?.intersectionRatio ?? 0) >= 0.5), {
      threshold: [0, 0.5, 0.9],
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const autoplay = !reduce;
  const playing = autoplay && !paused && !focused && visible;
  const stage = STAGES[active]!;

  const choose = (index: number) => {
    setActive(index);
    setRun((n) => n + 1);
  };
  const next = () => choose((active + 1) % STAGES.length);

  return (
    <section id="tech" aria-labelledby="tech-heading" data-surface="night" className="relative bg-night py-28 text-paper md:py-40">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(40%_30%_at_10%_5%,rgb(47_74_58/0.6),transparent_70%),radial-gradient(50%_40%_at_85%_100%,rgb(47_74_58/0.8),transparent_70%)]"
      />
      <Container className="relative">
        <div className="mx-auto grid max-w-2xl gap-3 text-center">
          <p className="font-mono text-sm font-bold tracking-wide text-coral uppercase">Under the hood</p>
          <h2 id="tech-heading" className="font-display text-[clamp(2rem,3.6vw,3rem)] leading-none font-black text-balance">
            From laser dots to a map you can walk.
          </h2>
          <p className="text-lg text-sage">How a phone scan becomes a 3D map in any browser, one stage at a time.</p>
        </div>

        <div
          onFocus={(e) => e.target.matches(":focus-visible") && setFocused(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
          }}
          className="mt-14 grid items-start gap-8 lg:mt-20 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-12 xl-text:lg:grid-cols-1"
        >
          {/* The player. On phones it sticks under the top bar while the list scrolls past. */}
          <div ref={player} className="sticky top-[4.75rem] z-10 bg-night/90 pb-2 backdrop-blur-sm lg:top-28 lg:bg-transparent lg:pb-0 lg:backdrop-blur-none">
            {/* Story bars: the current stage fills, then the next one starts. */}
            <div aria-hidden="true" className="grid grid-cols-6 gap-1.5 sm:gap-2">
              {STAGES.map((s, i) => {
                const isActive = i === active;
                const done = autoplay && i < active;
                return (
                  <span key={s.title} className="block h-1.5 overflow-hidden rounded-full bg-sage/20">
                    {isActive && autoplay ? (
                      <span
                        key={run}
                        className="pb-progress-x block h-full rounded-full bg-coral"
                        style={{ animationDuration: `${SECONDS}s`, animationPlayState: playing ? "running" : "paused" }}
                        onAnimationEnd={next}
                      />
                    ) : (
                      <span className={`block h-full rounded-full ${isActive || done ? "w-full" : "w-0"} ${isActive ? "bg-coral" : "bg-sage/60"}`} />
                    )}
                  </span>
                );
              })}
            </div>

            <div className="mt-3 overflow-hidden rounded-[2rem] bg-[#0D1510] shadow-[0_40px_80px_-40px_rgb(0_0_0/0.9),inset_0_0_0_1px_rgb(169_196_174/0.18)]">
              <div className="relative aspect-[4/3]">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_15%_0%,rgb(47_74_58/0.9),transparent_70%),radial-gradient(45%_40%_at_60%_95%,rgb(244_128_87/0.12),transparent_70%)]"
                />
                <div className="absolute top-1/2 left-1/2 w-[90%] -translate-x-1/2 -translate-y-1/2">
                  <Room stage={active} run={run} />
                </div>
              </div>
              <div className="flex items-center gap-4 border-t border-sage/15 px-5 py-4 sm:px-7">
                <p className="min-w-0 flex-1">
                  <span className="mr-2 inline-block rounded-full bg-paper/10 px-2.5 py-0.5 align-middle font-mono text-xs font-bold tracking-wide text-sage uppercase">
                    {String(active + 1).padStart(2, "0")} {stage.title}
                  </span>
                  <span className="align-middle font-display text-lg leading-tight font-black">{stage.tech}</span>
                </p>
                {autoplay ? (
                  <button
                    type="button"
                    onClick={() => setPaused((p) => !p)}
                    aria-label={paused ? "Play the stages" : "Pause the stages"}
                    className="grid size-11 shrink-0 place-items-center rounded-full bg-paper text-ink"
                  >
                    {paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <ol className="grid gap-1.5">
            {STAGES.map((s, i) => {
              const isActive = i === active;
              return (
                <li key={s.title}>
                  <button
                    type="button"
                    aria-current={isActive ? "step" : undefined}
                    onClick={() => choose(i)}
                    className={`grid w-full grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 rounded-2xl px-4 py-3 text-left transition-colors ${
                      isActive ? "bg-paper/10 ring-1 ring-sage/30" : "hover:bg-paper/5"
                    }`}
                  >
                    <span className={`pt-1 font-mono text-sm ${isActive ? "text-coral" : "text-sage"}`}>0{i + 1}</span>
                    <span>
                      <span className="block font-display text-xl leading-tight font-black">{s.title}</span>
                      <span className={`mt-1 block leading-snug ${isActive ? "text-paper/90" : "text-sage"}`}>{s.line}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </Container>
    </section>
  );
}
