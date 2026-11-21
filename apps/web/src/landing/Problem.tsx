import { ArrowUpRight } from "lucide-react";
import { useRef, type CSSProperties, type ReactNode } from "react";
import { useReducedMotion } from "../lib/preferences";
import { gsap, useGSAP, WIDE } from "./motion";
import { Container, Eyebrow } from "./shared";

/*
 * "The problem", told as four road signs while a floor plan changes beside them:
 * a map app's pin at the front door, then a flat and cluttered plan, then question
 * marks where the plan can't help, then the plan tilts, its walls rise into 3D and a
 * route draws itself. The section is pinned (it stays on screen while you scroll)
 * and the animation follows the scroll position. The walls are the same SVG stacked
 * in several layers along the Z axis, which reads as extruded 3D in plain CSS.
 */

const SIGNS = [
  {
    kicker: "Map apps",
    title: "Get you to the front door.",
    body: "Then the dot stops. Inside a campus, a hospital or a venue, you're on your own.",
  },
  {
    kicker: "Floor plans",
    title: "Flat, old and stuck to one wall.",
    body: "If there is one, it's a PDF or a board next to the elevator you were trying to find.",
  },
  {
    kicker: "“Accessible entrance”",
    title: "But where? And is there a step?",
    body: "Notes like this don't show the way, so people who avoid stairs find out at the door.",
  },
  {
    kicker: "Path",
    title: "See the real place in 3D, before you go.",
    body: "Someone scans it once with a phone. Everyone else picks a room and follows a route that can skip the stairs.",
  },
];

/* Plan coordinates: meters from the fixture, x → (x + 5) × 50, z → (1 − z) × 50. */
const WALLS = [
  "M200 10 V200 H25 V400 H200 V300",
  "M300 10 V200 H475 V400 H300 V300",
  "M25 300 H72 M128 300 H200",
  "M300 300 H372 M428 300 H475",
  "M200 400 H300",
];
const ROUTE = "M250 45 V215 Q250 250 215 250 H100 V350";
const WALL_LAYERS = 7;
const WALL_STEP = 6;

function Plan() {
  return (
    <svg viewBox="0 0 500 420" className="absolute inset-0 size-full" aria-hidden="true">
      <defs>
        <pattern id="plan-grid" width="25" height="25" patternUnits="userSpaceOnUse">
          <path d="M25 0 H0 V25" fill="none" stroke="#2F4A3A" strokeOpacity="0.09" strokeWidth="1" />
        </pattern>
        <pattern id="plan-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 0 V8" stroke="#2F4A3A" strokeOpacity="0.45" strokeWidth="2" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="500" height="420" rx="14" fill="#FAF5E6" />
      <rect x="0" y="0" width="500" height="420" rx="14" fill="url(#plan-grid)" />

      {/* Step 1: only the building outline and the map app's pin at the door. */}
      <g data-part="arrive" opacity="0">
        <rect x="18" y="4" width="464" height="404" rx="10" fill="none" stroke="#5E6B60" strokeWidth="3" strokeDasharray="10 8" />
        <circle cx="250" cy="28" r="11" fill="#2F4A3A" />
        <circle cx="250" cy="28" r="4" fill="#FAF5E6" />
      </g>

      {/* Step 2: the clutter of a typical posted plan. */}
      <g data-part="detail" opacity="0.35" fontFamily="Atkinson Hyperlegible Mono, monospace" fontSize="11" fill="#5E6B60">
        <rect x="200" y="300" width="100" height="100" fill="url(#plan-hatch)" />
        <rect x="215" y="140" width="70" height="40" fill="none" stroke="#5E6B60" strokeDasharray="4 4" />
        <text x="221" y="164">ELEV?</text>
        <text x="40" y="345">RM 1.04</text>
        <text x="40" y="362">(was 1.12)</text>
        <text x="330" y="345">RM 1.06</text>
        <text x="40" y="232">MECH</text>
        <text x="400" y="232">STOR.</text>
        <text x="216" y="355" fill="#2F4A3A">STAIRS</text>
        <text x="210" y="30">ENTR. B</text>
        <text x="380" y="410" fontSize="9">REV. 2014 · NOT TO SCALE</text>
      </g>
      {/* The route, drawn in the last step. */}
      <path data-part="route" d={ROUTE} fill="none" stroke="#F48057" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
    </svg>
  );
}

function WallLayer({ index }: { index: number }) {
  const top = index === WALL_LAYERS - 1;
  return (
    <svg
      viewBox="0 0 500 420"
      data-part="wall"
      data-z={index * WALL_STEP}
      className="absolute inset-0 size-full"
      style={{ transform: `translateZ(${index * WALL_STEP}px)` }}
      aria-hidden="true"
    >
      <g fill="none" stroke={top ? "#2F4A3A" : "#5E6B60"} strokeOpacity={top ? 1 : 0.55} strokeWidth="7" strokeLinecap="square">
        {WALLS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** A label that stands up out of the tilted plan (it undoes the plan's rotation). */
function Standing({ x, y, children, part, tone = "label" }: { x: number; y: number; children: ReactNode; part: string; tone?: "label" | "question" }) {
  return (
    <div
      data-part={part}
      className="absolute"
      style={{ ...(part === "question" ? { opacity: 0, visibility: "hidden" } : null), left: `${(x / 500) * 100}%`, top: `${(y / 420) * 100}%`, transform: `translateZ(${WALL_LAYERS * WALL_STEP + 4}px)` }}
    >
      <div className="origin-bottom -translate-x-1/2 -translate-y-full [transform:rotateZ(var(--plan-spin))_rotateX(calc(var(--plan-tilt)*-1))]">
        {tone === "question" ? (
          <span className="grid size-10 place-items-center rounded-full bg-paper font-display text-2xl font-black text-rust shadow-md ring-2 ring-rust">
            {children}
          </span>
        ) : (
          <span className="block rounded-full bg-night px-3 py-1.5 text-sm font-bold whitespace-nowrap text-paper shadow-lg ring-2 ring-coral">
            {children}
          </span>
        )}
      </div>
    </div>
  );
}

function Sign({ sign, index, answer }: { sign: (typeof SIGNS)[number]; index: number; answer: boolean }) {
  return (
    <li
      data-part="sign"
      className={`rounded-2xl p-1.5 shadow-[0_10px_30px_-18px_rgb(18_28_22/0.7)] ${answer ? "bg-coral text-ink" : "bg-forest text-paper"}`}
    >
      <div className={`rounded-xl px-5 py-4 ring-2 ${answer ? "ring-ink/70" : "ring-paper/80"}`}>
        <p className="flex items-center gap-2 font-mono text-sm tracking-wide uppercase">
          <span className={`grid size-6 place-items-center rounded-full ${answer ? "bg-ink text-coral" : "bg-coral text-ink"}`} aria-hidden="true">
            {answer ? "→" : index + 1}
          </span>
          {sign.kicker}
        </p>
        <h3 className="mt-2 font-display text-2xl leading-tight font-black">{sign.title}</h3>
        <p className={`mt-1 leading-snug ${answer ? "text-ink" : "text-paper/90"}`}>{sign.body}</p>
      </div>
    </li>
  );
}

export default function Problem() {
  const reduce = useReducedMotion();
  const animate = !reduce;
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (!animate || !root.current) return;
      const q = gsap.utils.selector(root);
      const stage = q("[data-part=stage]")[0] as HTMLElement | undefined;
      if (!stage) return;
      const signs = q("[data-part=sign]");
      const walls = q("[data-part=wall]");
      const navOffset = () => (document.querySelector("header")?.getBoundingClientRect().height ?? 0) + 0;
      const mm = gsap.matchMedia();

      mm.add({ wide: WIDE, narrow: "(max-width: 767.98px)" }, (context) => {
        const wide = Boolean(context.conditions?.wide);
        // Wide: every sign stays on screen and the current one lights up.
        // Narrow: the signs share one spot and swap.
        const off = wide ? { opacity: 0.28, scale: 0.97 } : { autoAlpha: 0, y: 16 };
        const on = wide ? { opacity: 1, scale: 1 } : { autoAlpha: 1, y: 0 };

        const tl = gsap.timeline({
          defaults: { ease: "none" },
          scrollTrigger: {
            trigger: root.current,
            start: () => `top ${navOffset()}`,
            end: "+=260%",
            pin: true,
            scrub: 0.6,
            invalidateOnRefresh: true,
          },
        });

        gsap.set(signs.slice(1), off);
        gsap.set(stage, { "--plan-tilt": "0deg", "--plan-spin": "0deg" });
        gsap.set(walls, { z: 0, autoAlpha: (i: number) => (i === WALL_LAYERS - 1 ? 1 : 0) });
        gsap.set(q("[data-part=detail]"), { autoAlpha: 0 });
        gsap.set(q("[data-part=question]"), { autoAlpha: 0, scale: 0.4 });
        gsap.set(q("[data-part=label], [data-part=pin]"), { autoAlpha: 0, y: 10 });
        gsap.set(q("[data-part=route]"), { strokeDasharray: 1, strokeDashoffset: 1 });
        gsap.set(q("[data-part=arrive]"), { autoAlpha: 1 });

        // 1 → 2: the floor plan appears.
        tl.to(signs[0]!, { ...off, duration: 0.3 }, 1)
          .to(signs[1]!, { ...on, duration: 0.3 }, 1)
          .to(q("[data-part=arrive]"), { autoAlpha: 0, duration: 0.3 }, 1)
          .to(q("[data-part=detail]"), { autoAlpha: 1, duration: 0.4 }, 1.05)
          // 2 → 3: questions where the plan can't help.
          .to(signs[1]!, { ...off, duration: 0.3 }, 2)
          .to(signs[2]!, { ...on, duration: 0.3 }, 2)
          .to(q("[data-part=question]"), { autoAlpha: 1, scale: 1, duration: 0.3, stagger: 0.12, ease: "back.out(2)" }, 2.05)
          // 3 → 4: the plan tilts, walls rise, the route draws.
          .to(signs[2]!, { ...off, duration: 0.3 }, 3)
          .to(signs[3]!, { ...on, duration: 0.3 }, 3)
          .to(q("[data-part=question]"), { autoAlpha: 0, scale: 0.4, duration: 0.2 }, 3)
          .to(stage, { "--plan-tilt": "55deg", "--plan-spin": "-32deg", duration: 0.8, ease: "power2.inOut" }, 3)
          .to(walls, { z: (i: number) => i * WALL_STEP, autoAlpha: 1, duration: 0.6, ease: "power2.out" }, 3.4)
          .to(q("[data-part=detail]"), { autoAlpha: 0.35, duration: 0.4 }, 3.4)
          .to(q("[data-part=route]"), { strokeDashoffset: 0, duration: 0.7 }, 3.9)
          .to(q("[data-part=label], [data-part=pin]"), { autoAlpha: 1, y: 0, duration: 0.3, stagger: 0.1 }, 4.4)
          .to({}, { duration: 0.4 });
      });
    },
    { scope: root, dependencies: [animate], revertOnUpdate: true },
  );

  return (
    <section
      ref={root}
      id="problem"
      aria-labelledby="problem-heading"
      className="relative overflow-hidden bg-paper py-14 md:flex md:min-h-[calc(100dvh-4.5rem)] md:items-center md:py-10"
    >
      <Container className="grid items-center gap-8 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-12">
        <div className="grid gap-5">
          <div className="grid gap-2">
            <Eyebrow>The problem</Eyebrow>
            <h2 id="problem-heading" className="font-display text-4xl leading-none font-black text-balance md:text-5xl">
              Maps stop at the door.
            </h2>
          </div>
          <ol
            className={
              animate
                ? "grid max-md:[&>li]:col-start-1 max-md:[&>li]:row-start-1 md:gap-3"
                : "grid gap-3"
            }
          >
            {SIGNS.map((sign, i) => (
              <Sign key={sign.kicker} sign={sign} index={i} answer={i === SIGNS.length - 1} />
            ))}
          </ol>
        </div>

        <div className="relative mx-auto w-full max-w-xl max-md:order-first [perspective:1600px]">
          <div
            data-part="stage"
            className="relative aspect-[500/420] w-full [transform-style:preserve-3d] [transform:rotateX(var(--plan-tilt))_rotateZ(var(--plan-spin))] max-md:mx-auto max-md:w-[min(100%,calc(40dvh*1.19))]"
            style={{ "--plan-tilt": "55deg", "--plan-spin": "-32deg" } as CSSProperties}
          >
            <Plan />
            {Array.from({ length: WALL_LAYERS }, (_, i) => (
              <WallLayer key={i} index={i} />
            ))}
            <Standing part="question" x={250} y={160} tone="question">?</Standing>
            <Standing part="question" x={250} y={330} tone="question">?</Standing>
            <Standing part="question" x={100} y={290} tone="question">?</Standing>
            <Standing part="label" x={250} y={60}>You are here</Standing>
            <Standing part="pin" x={100} y={350}>
              <span className="inline-flex items-center gap-1">
                Workshop room <ArrowUpRight className="size-4" aria-hidden />
              </span>
            </Standing>
            <Standing part="label" x={250} y={225}>Step-free route</Standing>
          </div>
        </div>
      </Container>
    </section>
  );
}
