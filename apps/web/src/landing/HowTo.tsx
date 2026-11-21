import { useMemo, useRef } from "react";
import { useReducedMotion } from "../lib/preferences";
import { FootprintShape, printsAlong } from "./Footprint";
import { gsap, useGSAP } from "./motion";
import { Container, Eyebrow } from "./shared";

/*
 * "How to use": three steps shown as highway route shields, joined by footprints
 * that step from one shield to the next as you scroll.
 */

const STEPS = [
  {
    title: "Log in",
    body: "Sign in to make and manage maps. Opening a map someone shared never needs an account.",
  },
  {
    title: "Make a map, or find one",
    body: "Scan with a LiDAR iPhone and upload it, or open one from Community. Add waypoints and name the rooms.",
  },
  {
    title: "Share it, or follow it",
    body: "Send a link or QR code as Public, Unlisted or Private. Visitors pick a destination and follow the route.",
  },
];

function Shield({ n }: { n: number }) {
  return (
    <svg viewBox="0 0 80 88" className="h-24 w-auto drop-shadow-[0_10px_14px_rgb(18_28_22/0.25)]" aria-hidden="true">
      <path d="M6 8 Q40 -2 74 8 Q80 52 40 86 Q0 52 6 8 Z" fill="#2F4A3A" />
      <path d="M11 12 Q40 4 69 12 Q74 50 40 80 Q6 50 11 12 Z" fill="none" stroke="#F3EBD0" strokeWidth="2.5" />
      <path d="M11 12 Q40 4 69 12 L70 26 H10 Z" fill="#F48057" />
      <text x="40" y="22" textAnchor="middle" fontFamily="Atkinson Hyperlegible Mono, monospace" fontSize="9" fontWeight="500" fill="#15221B" letterSpacing="1.5">
        STEP
      </text>
      <text x="40" y="62" textAnchor="middle" fontFamily="Overpass, sans-serif" fontWeight="900" fontSize="36" fill="#F3EBD0">
        {n}
      </text>
    </svg>
  );
}

/** Footprints along a path, measured from the rendered path so they follow its curve. */
function Prints({ d, viewBox, stride, className }: { d: string; viewBox: string; stride: number; className: string }) {
  const prints = useMemo(() => printsAlong(d, stride, 7, 14), [d, stride]);
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true">
      <path d={d} fill="none" stroke="#2F4A3A" strokeOpacity="0.18" strokeWidth="2" strokeDasharray="2 8" />
      <g fill="#2F4A3A">
        {prints.map((p, i) => (
          <g key={i} transform={`translate(${p.x} ${p.y}) rotate(${p.angle}) scale(${p.left ? -1.3 : 1.3} 1.3)`}>
            <g data-part="print" opacity="0.55">
              <FootprintShape />
            </g>
          </g>
        ))}
      </g>
    </svg>
  );
}

export default function HowTo() {
  const reduce = useReducedMotion();
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (reduce || !root.current) return;
      const q = gsap.utils.selector(root);
      // Each visible trail (wide or phone layout) gets its own scrubbed reveal.
      q("[data-part=trail]").forEach((trail) => {
        const prints = (trail as Element).querySelectorAll("[data-part=print]");
        if (!prints.length) return;
        gsap.fromTo(
          prints,
          { opacity: 0 },
          {
            opacity: 0.55,
            stagger: 0.25,
            ease: "none",
            scrollTrigger: { trigger: root.current, start: "top 70%", end: "bottom 75%", scrub: 0.5 },
          },
        );
      });
    },
    { scope: root, dependencies: [reduce], revertOnUpdate: true },
  );

  return (
    <section ref={root} aria-labelledby="how-heading" className="relative bg-surface py-20 md:py-28">
      <Container>
        <div className="grid max-w-3xl gap-3">
          <Eyebrow>How to use it</Eyebrow>
          <h2 id="how-heading" className="font-display text-4xl leading-none font-black text-balance md:text-5xl">
            Three stops from here to there.
          </h2>
        </div>

        <div className="relative mt-12">
          {/* Wide screens: one trail across, from shield to shield. */}
          <div data-part="trail" className="pointer-events-none absolute inset-x-0 top-0 hidden h-24 md:block xl-text:md:hidden">
            <Prints
              d="M150 50 C 260 -10, 360 110, 500 50 S 760 -10, 850 50"
              viewBox="0 0 1000 100"
              stride={34}
              className="size-full"
            />
          </div>
          <ol className="relative grid gap-4 md:grid-cols-3 md:gap-8 xl-text:md:grid-cols-1">
            {STEPS.map((step, i) => (
              <li key={step.title} className="grid justify-items-start gap-3 md:justify-items-center md:text-center xl-text:md:justify-items-start xl-text:md:text-left">
                <Shield n={i + 1} />
                <h3 className="font-display text-2xl leading-tight font-black">{step.title}</h3>
                <p className="max-w-sm text-lg leading-snug text-muted">{step.body}</p>
                {i < STEPS.length - 1 ? (
                  <div data-part="trail" className="h-24 w-16 md:hidden xl-text:md:block">
                    <Prints d="M30 4 C 10 30, 50 60, 30 96" viewBox="0 0 60 100" stride={22} className="size-full" />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </Container>
    </section>
  );
}
