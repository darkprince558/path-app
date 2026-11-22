import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Container } from "./shared";

/*
 * "Who it's for": one open scene, no card. Four people stand along a single coral
 * route, each below a small wayfinding sign. When they scroll into view they walk
 * (or roll) to their sign one after another, and again on hover or tap. Figures are
 * pictograms like the ones on airport and hospital signs, drawn in currentColor.
 * The motion is CSS keyframes, so Reduce motion shows everyone already at their sign.
 */

const INK = "currentColor";
const CORAL = "#F48057";

/* ------------------------------------------------------------ figures */
/* Feet rest on y = 108. Each figure is drawn around x = 0. */

function Legs() {
  return (
    <>
      <line className="pg-swing" x1="-3" y1="68" x2="-3" y2="106" stroke={INK} strokeWidth="8" strokeLinecap="round" />
      <line className="pg-swing pg-swing-alt" x1="3" y1="68" x2="3" y2="106" stroke={INK} strokeWidth="8" strokeLinecap="round" />
    </>
  );
}

function Student() {
  return (
    <g>
      <rect x="-15" y="36" width="10" height="24" rx="3" fill={INK} opacity="0.6" />
      <circle cx="0" cy="22" r="8.5" fill={INK} />
      <line x1="0" y1="35" x2="0" y2="66" stroke={INK} strokeWidth="13" strokeLinecap="round" />
      <line className="pg-swing pg-swing-alt" x1="-2" y1="38" x2="-8" y2="62" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      <path d="M2 38 L10 52 L15 45" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="13" y="36" width="6" height="10" rx="1.5" fill={CORAL} />
      <Legs />
    </g>
  );
}

/** After the Accessible Icon Project: leaning forward, arms pushing, a plain wheel. */
function WheelchairUser() {
  return (
    <g>
      <circle cx="12" cy="22" r="8.5" fill={INK} />
      <line x1="7" y1="35" x2="0" y2="64" stroke={INK} strokeWidth="12" strokeLinecap="round" />
      <path d="M7 41 L20 58" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      <path d="M0 66 H22 L29 94" fill="none" stroke={INK} strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="0" cy="86" r="21" fill="none" stroke={INK} strokeWidth="6" />
      <circle cx="33" cy="104" r="4" fill={INK} />
    </g>
  );
}

function EventTeam() {
  return (
    <g>
      <circle cx="0" cy="22" r="8.5" fill={INK} />
      <line x1="0" y1="35" x2="0" y2="66" stroke={INK} strokeWidth="13" strokeLinecap="round" />
      <line className="pg-swing" x1="-2" y1="38" x2="-8" y2="62" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      <line x1="2" y1="38" x2="13" y2="30" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      <line x1="14" y1="4" x2="14" y2="62" stroke={INK} strokeWidth="3" strokeLinecap="round" />
      <rect x="15" y="4" width="28" height="16" rx="2" fill={CORAL} />
      <Legs />
    </g>
  );
}

function Explorer() {
  return (
    <g>
      <path d="M-12 15 H12" stroke={INK} strokeWidth="4" strokeLinecap="round" />
      <path d="M-7 15 Q0 4 7 15 Z" fill={INK} />
      <circle cx="0" cy="22" r="8.5" fill={INK} />
      <line x1="0" y1="35" x2="0" y2="66" stroke={INK} strokeWidth="13" strokeLinecap="round" />
      <line className="pg-swing pg-swing-alt" x1="-2" y1="38" x2="-8" y2="62" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      <line x1="2" y1="38" x2="12" y2="58" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      <line x1="13" y1="54" x2="20" y2="108" stroke={CORAL} strokeWidth="3.5" strokeLinecap="round" />
      <Legs />
    </g>
  );
}

/* --------------------------------------------------------------- people */

interface Person {
  who: string;
  line: string;
  sign: string;
  arrow: Direction;
  figure: ReactNode;
  rolls?: boolean;
}

type Direction = "right" | "up" | "up-right";

const PEOPLE: Person[] = [
  { who: "Students", line: "Find Room 204 before the exam.", sign: "Room 204", arrow: "right", figure: <Student /> },
  {
    who: "Wheelchair users",
    line: "Check a place first, then take the step-free route.",
    sign: "Elevator",
    arrow: "up",
    figure: <WheelchairUser />,
    rolls: true,
  },
  { who: "Event teams", line: "Label the venue your way, room by room.", sign: "Sponsor booth", arrow: "right", figure: <EventTeam /> },
  { who: "Explorers", line: "Share the trails and places you know.", sign: "Trailhead", arrow: "up-right", figure: <Explorer /> },
];

/**
 * Sign arrows are drawn, not typed: typed arrows (→ ↑ ↗) come out at different
 * weights in different fonts, and iPhones show ↗ as an emoji. 12 × 12 units.
 */
function SignArrow({ direction, x, y }: { direction: Direction; x: number; y: number }) {
  const rotate = direction === "right" ? 0 : direction === "up" ? -90 : -45;
  return (
    <g transform={`translate(${x + 6} ${y + 6}) rotate(${rotate})`}>
      <path d="M-5.5 0 H5 M0.5 -4.5 L5 0 L0.5 4.5" fill="none" stroke="#F3EBD0" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

/** Scene units: 260 × 146, route at y = 136. The figure walks from x = 36 to x = 136, stopping short of the post. */
const WALK = 100;
/** Seconds one walk takes (matches .pg-walker in index.css). On a laptop each person starts when the one before arrives. */
const WALK_SECONDS = 2.6;

function Scene({ person, run, delay }: { person: Person; run: number; delay: number }) {
  const textWidth = person.sign.length * 8.4;
  const signWidth = Math.round(textWidth + 46);
  const style = { "--walk": `${WALK}px`, "--pg-delay": `${delay}s`, animationDelay: `${delay}s` } as CSSProperties;
  return (
    <svg viewBox="0 0 260 146" className="w-full overflow-visible text-forest" aria-hidden="true">
      {/* The shared route runs past both edges, so it stays one line across the gaps between people. */}
      <line x1="-24" y1="138" x2="284" y2="138" stroke={CORAL} strokeWidth="4" strokeLinecap="round" strokeDasharray="2 10" />
      {/* Sign on a post. */}
      <line x1="236" y1="28" x2="236" y2="136" stroke="currentColor" strokeWidth="4" />
      <g transform={`translate(${256 - signWidth} 0)`}>
        <rect width={signWidth} height="30" rx="6" fill="#2F4A3A" />
        <rect x="2.5" y="2.5" width={signWidth - 5} height="25" rx="4" fill="none" stroke="#F3EBD0" strokeOpacity="0.8" strokeWidth="1.5" />
        <text x="13" y="20.5" fontFamily="Overpass, sans-serif" fontWeight="900" fontSize="14" fill="#F3EBD0">
          {person.sign}
        </text>
        <SignArrow direction={person.arrow} x={signWidth - 25} y={9} />
      </g>
      <g transform="translate(36 28)">
        {run > 0 ? (
          <g key={run} className={`pg-walker ${person.rolls ? "" : "pg-walking"}`} style={style}>
            {person.figure}
          </g>
        ) : (
          <g>{person.figure}</g>
        )}
      </g>
    </svg>
  );
}

function PersonStop({ person, index }: { person: Person; index: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const [run, setRun] = useState(0);
  const [first, setFirst] = useState(true);

  // Walk once when this person comes into view. Side by side on a laptop they all
  // come into view together, so each one starts when the one before arrives.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setRun(1);
          observer.disconnect();
        }
      },
      { threshold: 0.6 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const wide = typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
  return (
    <li
      ref={ref}
      onPointerEnter={() => {
        setFirst(false);
        setRun((n) => n + 1);
      }}
      className={`grid w-[80%] content-start gap-3 lg:w-auto ${index % 2 ? "justify-self-end" : "justify-self-start"} lg:justify-self-auto`}
    >
      <Scene person={person} run={run} delay={first && wide ? index * WALK_SECONDS : 0} />
      <div className="px-2 text-center lg:px-4">
        <h3 className="font-display text-2xl leading-tight font-black">{person.who}</h3>
        <p className="mt-1.5 text-lg leading-snug text-balance text-muted">{person.line}</p>
      </div>
    </li>
  );
}

/** Phones: the route zigzags down from one person to the next. */
function Connector({ toRight }: { toRight: boolean }) {
  return (
    <li aria-hidden="true" className="my-8 h-28 lg:hidden xl-text:lg:block">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="size-full">
        <path
          d={toRight ? "M40 0 C40 20, 60 20, 60 40" : "M60 0 C60 20, 40 20, 40 40"}
          fill="none"
          stroke={CORAL}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray="2 10"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </li>
  );
}

export default function WhoUses() {
  return (
    <section id="who" aria-labelledby="who-heading" className="bg-paper py-28 md:py-40">
      <Container>
        <h2 id="who-heading" className="text-center font-display text-[clamp(2rem,3.6vw,3rem)] leading-none font-black text-balance">
          One app. A lot of different trips.
        </h2>
        <ul className="mx-auto mt-16 grid max-w-md lg:mt-20 lg:max-w-none lg:grid-cols-4 lg:gap-10 xl-text:lg:max-w-md xl-text:lg:grid-cols-1">
          {PEOPLE.map((person, i) => (
            <Fragment key={person.who}>
              <PersonStop person={person} index={i} />
              {i < PEOPLE.length - 1 ? <Connector toRight={i % 2 === 0} /> : null}
            </Fragment>
          ))}
        </ul>
      </Container>
    </section>
  );
}
