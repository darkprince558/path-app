import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useReducedMotion } from "../lib/preferences";
import { Container } from "./shared";
import { buildVenueCloud } from "./venue";

/*
 * "The problem": what people use today to find their way inside, and where each one
 * runs out, ending with Path. All five points stay readable in a list. A dark screen
 * beside them (styled like the hero) plays a short scene for the highlighted point,
 * then moves on by itself. The loop pauses while you hover, focus or are scrolled
 * away, has a Pause button, and with Reduce motion it doesn't move on its own: each
 * scene shows its finished picture and you pick the point.
 */

interface Point {
  id: string;
  tool: string;
  title: string;
  body: string;
  /** Seconds this scene plays before the next one. */
  seconds: number;
  scene: () => ReactNode;
}

/* ------------------------------------------------------------ helpers */

/** Position an HTML label over a scene, in the scene's own 400 × 300 units. */
function At({ x, y, children, className = "", style }: { x: number; y: number; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`absolute ${className}`} style={{ left: `${(x / 400) * 100}%`, top: `${(y / 300) * 100}%`, ...style }}>
      {children}
    </div>
  );
}

function Chip({ children, tone = "glass", className = "", style }: { children: ReactNode; tone?: "glass" | "paper"; className?: string; style?: CSSProperties }) {
  return (
    <span
      className={`inline-block rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap shadow-lg sm:text-sm ${
        tone === "paper" ? "bg-paper text-ink" : "bg-[#1B2A21]/80 text-paper ring-1 ring-sage/25 backdrop-blur"
      } ${className}`}
      style={style}
    >
      {children}
    </span>
  );
}

const delay = (s: number): CSSProperties => ({ animationDelay: `${s}s` });

/* Floor plan in its own units (500 × 420), shared by the floor plan and checkmark scenes. */
const WALLS = [
  "M200 10 V200 H25 V400 H200 V300",
  "M300 10 V200 H475 V400 H300 V300",
  "M25 300 H72 M128 300 H200",
  "M300 300 H372 M428 300 H475",
  "M200 400 H300",
];

/* --------------------------------------------------------------- scenes */

const MAP_BLUE = "#4C8DF6";

function MapAppScene() {
  return (
    <>
      <svg viewBox="0 0 400 300" className="absolute inset-0 size-full" aria-hidden="true">
        <g stroke="#24372C" strokeWidth="26" strokeLinecap="square">
          <path d="M0 220 H400 M60 0 V300 M340 0 V300" />
        </g>
        <rect x="355" y="0" width="45" height="300" fill="#24402F" />
        <rect x="140" y="40" width="160" height="125" rx="6" fill="#2A3A31" stroke="#5E6B60" strokeWidth="2" />
        <path d="M150 52 H290" stroke="#5E6B60" strokeOpacity="0.5" strokeDasharray="4 6" />
        <path d="M60 300 V220 H220 V165" fill="none" stroke={MAP_BLUE} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" strokeOpacity="0.55" />
        <circle className="pb-accuracy" cx="220" cy="110" r="46" fill={MAP_BLUE} fillOpacity="0.14" stroke={MAP_BLUE} strokeOpacity="0.5" style={delay(2.1)} />
        <g className="pb-gps">
          <circle r="11" fill={MAP_BLUE} fillOpacity="0.25" />
          <circle r="7" fill={MAP_BLUE} stroke="#F3EBD0" strokeWidth="2.5" />
        </g>
      </svg>
      <At x={232} y={176} className="pb-pop" style={delay(1.8)}>
        <Chip>You have arrived</Chip>
      </At>
      <At x={150} y={64} className="pb-pop" style={delay(2.9)}>
        <Chip tone="paper">Where's Room 204?</Chip>
      </At>
    </>
  );
}

function IndoorMapsScene() {
  const rows = [
    { name: "Airport, Terminal 1", ok: true },
    { name: "Shopping mall", ok: true },
    { name: "Science building", ok: false },
  ];
  return (
    <div className="absolute inset-0 grid content-center gap-2.5 px-[8%]">
      <div className="pb-rise flex items-center gap-2 rounded-xl bg-paper/10 px-4 py-3 text-sm text-sage ring-1 ring-sage/25">
        <span aria-hidden="true">⌕</span> Indoor maps near you
      </div>
      {rows.map((row, i) => (
        <div
          key={row.name}
          className={`pb-rise flex items-center justify-between gap-3 rounded-xl px-4 py-3 ring-1 ${
            row.ok ? "bg-[#1B2A21]/80 ring-sage/25" : "pb-shake bg-[#1B2A21]/80 ring-coral/70"
          }`}
          style={{ animationDelay: row.ok ? `${0.25 + i * 0.25}s` : "0.75s, 1.7s" }}
        >
          <span className="font-bold text-paper">{row.name}</span>
          <span className={`flex items-center gap-1.5 text-sm ${row.ok ? "text-sage" : "text-paper"}`}>
            <span
              aria-hidden="true"
              className={`grid size-5 place-items-center rounded-full text-xs font-black ${row.ok ? "bg-sage text-ink" : "bg-coral text-ink"}`}
            >
              {row.ok ? "✓" : "✕"}
            </span>
            {row.ok ? "Indoor map" : "No indoor map"}
          </span>
        </div>
      ))}
      <p className="pb-rise text-center font-mono text-xs text-sage" style={delay(1.2)}>
        Added by the venue owner. Mostly airports and malls.
      </p>
    </div>
  );
}

function FloorPlanScene() {
  return (
    <div className="absolute inset-[7%] overflow-hidden rounded-lg bg-paper shadow-2xl [transform:rotate(-1.5deg)]">
      <svg viewBox="0 0 500 420" className="pb-zoom size-full origin-[16%_84%]" aria-hidden="true">
        <defs>
          <pattern id="pb-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <path d="M0 0 V8" stroke="#2F4A3A" strokeOpacity="0.45" strokeWidth="2" />
          </pattern>
        </defs>
        <g fill="none" stroke="#2F4A3A" strokeWidth="6" strokeLinecap="square">
          {WALLS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        <rect x="200" y="300" width="100" height="100" fill="url(#pb-hatch)" />
        <g fontFamily="Atkinson Hyperlegible Mono, monospace" fontSize="12" fill="#5E6B60">
          <text x="40" y="350">RM 1.12</text>
          <text x="330" y="345">RM 1.06</text>
          <text x="40" y="232">MECH</text>
          <text x="400" y="232">STOR.</text>
          <text x="216" y="290">STAIRS</text>
          <text x="221" y="164">ELEV?</text>
          <text x="210" y="30">ENTR. B</text>
          <text x="360" y="410" fontSize="10">REV. 2014 · NOT TO SCALE</text>
        </g>
        <path className="pb-draw" d="M36 346 H100" stroke="#A8421F" strokeWidth="3" pathLength={1} style={delay(2)} />
        <text className="pb-pop-svg" x="40" y="376" fontFamily="Atkinson Hyperlegible Next, sans-serif" fontWeight="700" fontSize="16" fill="#A8421F" style={delay(2.3)}>
          now 1.04?
        </text>
      </svg>
    </div>
  );
}

function CheckmarkScene() {
  return (
    <>
      <svg viewBox="0 0 500 420" className="absolute inset-x-[10%] top-[24%] bottom-[4%] m-auto h-[72%]" aria-hidden="true">
        <g fill="none" stroke="#A9C4AE" strokeOpacity="0.45" strokeWidth="6" strokeLinecap="square">
          {WALLS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        <g stroke="#A9C4AE" strokeOpacity="0.6" strokeWidth="4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <path key={i} d={`M205 ${300 + i * 16} H295`} />
          ))}
        </g>
        <path className="pb-draw" d="M250 20 V290" fill="none" stroke="#F48057" strokeWidth="8" strokeLinecap="round" strokeDasharray="1" pathLength={1} style={delay(0.8)} />
        <circle className="pb-flash" cx="250" cy="340" r="62" fill="none" stroke="#F48057" strokeWidth="6" style={delay(2.3)} />
      </svg>
      <At x={200} y={20} className="pb-rise -translate-x-1/2">
        <div className="flex items-center gap-3 rounded-2xl bg-[#1B2A21]/85 px-4 py-2.5 text-paper ring-1 ring-sage/25 backdrop-blur">
          <span className="font-bold whitespace-nowrap">Science building</span>
          <span className="rounded-full bg-sage px-2.5 py-1 text-xs font-bold whitespace-nowrap text-ink">Accessible entrance ✓</span>
        </div>
      </At>
      <At x={262} y={236} className="pb-pop" style={delay(2.5)}>
        <Chip tone="paper">Stairs. Now what?</Chip>
      </At>
    </>
  );
}

/** The fixture's T corridor as dots, seen from above at an angle (isometric). */
function useIsoDots() {
  return useMemo(() => {
    const cloud = buildVenueCloud(1200);
    const k = 26;
    const iso = (x: number, y: number, z: number) => ({ sx: 152 + (x - z) * 0.866 * k, sy: 214 + (x + z) * 0.5 * k - y * k * 0.85 });
    const dots: { x: number; y: number; fill: string }[] = [];
    for (let i = 0; i < cloud.count; i++) {
      const x = cloud.positions[i * 3]!;
      const y = cloud.positions[i * 3 + 1]!;
      const z = cloud.positions[i * 3 + 2]!;
      const p = iso(x, y, z);
      const c = (j: number) => Math.round((cloud.colors[i * 3 + j] ?? 0) * 255);
      dots.push({ x: p.sx, y: p.sy, fill: `rgb(${c(0)} ${c(1)} ${c(2)})` });
    }
    return { dots, iso };
  }, []);
}

function PathScene() {
  const { dots, iso } = useIsoDots();
  const entrance = iso(0, 0, 0);
  const junction = iso(0, 0, -4);
  const room = iso(-3, 0, -4);
  const stairs = iso(3, 0, -4);
  return (
    <>
      <svg viewBox="0 0 400 300" className="absolute inset-0 size-full" aria-hidden="true">
        <g className="pb-assemble">
          {dots.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r="1.35" fill={d.fill} />
          ))}
        </g>
        <path
          className="pb-draw"
          d={`M${entrance.sx} ${entrance.sy} L${junction.sx} ${junction.sy} L${room.sx} ${room.sy}`}
          fill="none"
          stroke="#F48057"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          style={delay(0.9)}
        />
        <g className="pb-pop-svg" style={delay(2.2)}>
          <line x1={room.sx} y1={room.sy} x2={room.sx} y2={room.sy - 34} stroke="#F48057" strokeWidth="2.5" />
          <circle cx={room.sx} cy={room.sy - 38} r="7" fill="#F48057" />
        </g>
        <g className="pb-pop-svg" style={delay(1.6)}>
          <circle cx={stairs.sx} cy={stairs.sy - 18} r="11" fill="#121C16" stroke="#F48057" strokeWidth="2.5" />
          <path d={`M${stairs.sx - 5} ${stairs.sy - 23} l10 10 m0 -10 l-10 10`} stroke="#F48057" strokeWidth="2.5" strokeLinecap="round" />
        </g>
      </svg>
      <At x={room.sx} y={room.sy - 70} className="pb-pop -translate-x-1/2" style={delay(2.3)}>
        <Chip>Room 204</Chip>
      </At>
      <At x={stairs.sx + 14} y={stairs.sy - 30} className="pb-pop" style={delay(1.7)}>
        <Chip>Stairs skipped</Chip>
      </At>
      <At x={14} y={14} className="pb-rise right-[4%]" style={delay(2.6)}>
        <div className="max-w-[17rem] rounded-xl bg-paper px-3.5 py-2.5 text-ink shadow-xl">
          <p className="text-sm leading-tight font-bold">At the junction, turn left to the amber door</p>
          <p className="mt-0.5 font-mono text-[0.7rem] text-muted">Approved by the map owner</p>
        </div>
      </At>
    </>
  );
}

const POINTS: Point[] = [
  {
    id: "map-apps",
    tool: "Map apps",
    title: "Google Maps and Apple Maps get you to the door.",
    body: "Then the building is a grey box, and indoors the blue dot drifts.",
    seconds: 5,
    scene: () => <MapAppScene />,
  },
  {
    id: "indoor",
    tool: "Indoor maps",
    title: "Only for the big venues.",
    body: "Mostly airports and malls, added by the venue owner. Your lecture building or this weekend's venue usually isn't there.",
    seconds: 4.5,
    scene: () => <IndoorMapsScene />,
  },
  {
    id: "plans",
    tool: "Floor plans",
    title: "Flat, and out of date.",
    body: "A PDF or a board on the wall. Rooms get renamed, and you can't see what the turn looks like.",
    seconds: 4.5,
    scene: () => <FloorPlanScene />,
  },
  {
    id: "checkmark",
    tool: "“Accessible entrance ✓”",
    title: "A checkmark, not a route.",
    body: "It says yes or no. You find the stairs when you get to them.",
    seconds: 4.5,
    scene: () => <CheckmarkScene />,
  },
  {
    id: "path",
    tool: "Path",
    title: "The real place, mapped by people who know it.",
    body: "Scan it with a phone, label the rooms, share a link. Visitors see it in 3D and follow a route that can skip the stairs.",
    seconds: 6.5,
    scene: () => <PathScene />,
  },
];

/* -------------------------------------------------------------- section */

export default function Problem() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);
  const [run, setRun] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const screen = useRef<HTMLDivElement>(null);

  // Play only while the screen itself is mostly in view.
  useEffect(() => {
    const element = screen.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible((entry?.intersectionRatio ?? 0) >= 0.4), { threshold: [0, 0.4, 0.8] });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const autoplay = !reduce;
  const playing = autoplay && !paused && !hovering && !focused && visible;

  const choose = (index: number) => {
    setActive(index);
    setRun((n) => n + 1);
  };
  const next = () => choose((active + 1) % POINTS.length);

  return (
    <section id="problem" aria-labelledby="problem-heading" className="bg-paper py-20 md:py-28">
      <Container>
        <div className="mx-auto grid max-w-2xl gap-4 text-center">
          <h2 id="problem-heading" className="font-display text-[clamp(2rem,3.6vw,3rem)] leading-none font-black text-balance">
            Maps stop at the front door.
          </h2>
          <p className="text-lg leading-relaxed text-muted">
            Google Maps and Apple Maps are great at getting you to a building. Step inside and you're mostly on your own.
            Here's what people use instead, and where each one runs out.
          </p>
        </div>

        <div
          onPointerEnter={(e) => e.pointerType === "mouse" && setHovering(true)}
          onPointerLeave={() => setHovering(false)}
          onFocus={(e) => e.target.matches(":focus-visible") && setFocused(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
          }}
          className="mt-12 grid items-center gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-12 xl-text:lg:grid-cols-1"
        >
          <ol className="grid gap-1.5 max-lg:order-last">
            {POINTS.map((point, i) => {
              const isActive = i === active;
              const isPath = point.id === "path";
              return (
                <li key={point.id}>
                  <button
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => choose(i)}
                    className={`relative grid w-full gap-1 overflow-hidden rounded-2xl py-3.5 pr-4 pl-6 text-left transition-colors duration-300 ${
                      isActive ? "bg-surface shadow-[0_12px_30px_-22px_rgb(18_28_22/0.6)] ring-1 ring-forest/15" : "hover:bg-surface/60"
                    }`}
                  >
                    {/* Progress line: fills while this point plays, then moves on. */}
                    <span aria-hidden="true" className={`absolute top-3 bottom-3 left-2.5 w-1 rounded-full ${isActive ? "bg-forest/12" : "bg-transparent"}`}>
                      {isActive ? (
                        <span
                          key={run}
                          className={`block w-full rounded-full bg-coral ${autoplay ? "pb-progress" : "h-full"}`}
                          style={autoplay ? { animationDuration: `${point.seconds}s`, animationPlayState: playing ? "running" : "paused" } : undefined}
                          onAnimationEnd={autoplay ? next : undefined}
                        />
                      ) : null}
                    </span>
                    <span className={`font-mono text-sm tracking-wide uppercase ${isPath ? "text-rust" : "text-muted"}`}>{point.tool}</span>
                    <span className="font-display text-xl leading-tight font-black">{point.title}</span>
                    <span className="leading-snug text-muted">{point.body}</span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div
            ref={screen}
            data-surface="night"
            className="relative aspect-[4/3] overflow-hidden rounded-[2rem] bg-night shadow-[0_40px_80px_-40px_rgb(18_28_22/0.9)]"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_15%_0%,rgb(47_74_58/0.9),transparent_70%),radial-gradient(45%_40%_at_60%_95%,rgb(244_128_87/0.12),transparent_70%)]"
            />
            {POINTS.map((point, i) => (
              <div
                key={point.id}
                aria-hidden="true"
                className="absolute inset-0 transition-opacity duration-500"
                style={{ opacity: i === active ? 1 : 0 }}
              >
                {i === active ? <div key={run} className="absolute inset-0">{point.scene()}</div> : null}
              </div>
            ))}
            <div className="absolute inset-x-4 bottom-4 flex items-center justify-between gap-3">
              <span className="rounded-full bg-[#1B2A21]/80 px-3 py-1.5 font-mono text-xs text-sage ring-1 ring-sage/25 backdrop-blur">
                {active + 1} / {POINTS.length} · {POINTS[active]!.tool}
              </span>
              {autoplay ? (
                <button
                  type="button"
                  onClick={() => setPaused((p) => !p)}
                  aria-label={paused ? "Play the comparison" : "Pause the comparison"}
                  className="grid size-11 place-items-center rounded-full bg-paper text-ink shadow-lg"
                >
                  {paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
