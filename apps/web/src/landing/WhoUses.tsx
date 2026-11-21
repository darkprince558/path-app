import { useEffect, useRef, useState, type ReactNode } from "react";
import { Container, Eyebrow } from "./shared";

/*
 * "Who it's for" as one big wayfinding sign: white-on-green pictograms, like the
 * signs in an airport or a hospital. Each row's figure walks its coral route to a
 * destination when the row scrolls into view, and again on hover or tap. The motion
 * is CSS keyframes, so Reduce motion jumps straight to the arrived state.
 */

const PAPER = "#F3EBD0";
const CORAL = "#F48057";

/* ------------------------------------------------------------ figures */

function Legs() {
  return (
    <>
      <line className="pg-swing" x1="-3" y1="68" x2="-3" y2="106" stroke={PAPER} strokeWidth="8" strokeLinecap="round" />
      <line className="pg-swing pg-swing-alt" x1="3" y1="68" x2="3" y2="106" stroke={PAPER} strokeWidth="8" strokeLinecap="round" />
    </>
  );
}

function Student() {
  return (
    <g>
      <rect x="-15" y="36" width="10" height="24" rx="3" fill={PAPER} opacity="0.75" />
      <circle cx="0" cy="22" r="8.5" fill={PAPER} />
      <line x1="0" y1="35" x2="0" y2="66" stroke={PAPER} strokeWidth="13" strokeLinecap="round" />
      <line className="pg-swing pg-swing-alt" x1="-2" y1="38" x2="-8" y2="62" stroke={PAPER} strokeWidth="6" strokeLinecap="round" />
      <path d="M2 38 L10 52 L15 45" fill="none" stroke={PAPER} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="13" y="36" width="6" height="10" rx="1.5" fill={CORAL} />
      <Legs />
    </g>
  );
}

function Explorer() {
  return (
    <g>
      <path d="M-12 15 H12" stroke={PAPER} strokeWidth="4" strokeLinecap="round" />
      <path d="M-7 15 Q0 4 7 15 Z" fill={PAPER} />
      <circle cx="0" cy="22" r="8.5" fill={PAPER} />
      <line x1="0" y1="35" x2="0" y2="66" stroke={PAPER} strokeWidth="13" strokeLinecap="round" />
      <line className="pg-swing pg-swing-alt" x1="-2" y1="38" x2="-8" y2="62" stroke={PAPER} strokeWidth="6" strokeLinecap="round" />
      <line x1="2" y1="38" x2="12" y2="58" stroke={PAPER} strokeWidth="6" strokeLinecap="round" />
      <line x1="13" y1="54" x2="20" y2="108" stroke={CORAL} strokeWidth="3.5" strokeLinecap="round" />
      <Legs />
    </g>
  );
}

function EventTeam() {
  return (
    <g>
      <circle cx="0" cy="22" r="8.5" fill={PAPER} />
      <line x1="0" y1="35" x2="0" y2="66" stroke={PAPER} strokeWidth="13" strokeLinecap="round" />
      <line className="pg-swing" x1="-2" y1="38" x2="-8" y2="62" stroke={PAPER} strokeWidth="6" strokeLinecap="round" />
      <line x1="2" y1="38" x2="13" y2="30" stroke={PAPER} strokeWidth="6" strokeLinecap="round" />
      <line x1="14" y1="4" x2="14" y2="62" stroke={PAPER} strokeWidth="3" strokeLinecap="round" />
      <rect x="15" y="4" width="30" height="17" rx="2" fill={CORAL} />
      <path d="M20 12.5 H40" stroke="#15221B" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="5 3" />
      <Legs />
    </g>
  );
}

/** Active, forward-leaning wheelchair figure (after the Accessible Icon Project). */
function WheelchairUser() {
  return (
    <g>
      <circle cx="10" cy="20" r="8.5" fill={PAPER} />
      <line x1="5" y1="33" x2="-2" y2="62" stroke={PAPER} strokeWidth="12" strokeLinecap="round" />
      <path d="M5 38 L18 50" stroke={PAPER} strokeWidth="6" strokeLinecap="round" />
      <path d="M-2 64 H20 L28 92" fill="none" stroke={PAPER} strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
      <g className="pg-wheel">
        <circle cx="-2" cy="84" r="22" fill="none" stroke={PAPER} strokeWidth="6" />
        <path d="M-2 62 V106 M-24 84 H20 M-17.5 68.5 L13.5 99.5 M13.5 68.5 L-17.5 99.5" stroke={PAPER} strokeWidth="2" opacity="0.7" />
      </g>
      <circle cx="30" cy="102" r="4.5" fill={PAPER} />
    </g>
  );
}

/* ------------------------------------------------------- destinations */

function Door() {
  return (
    <g>
      <rect x="0" y="38" width="34" height="70" rx="2" fill="none" stroke={PAPER} strokeWidth="5" />
      <circle cx="26" cy="74" r="3" fill={PAPER} />
      <rect x="2" y="16" width="30" height="16" rx="3" fill={PAPER} />
      <text x="17" y="28.5" textAnchor="middle" fontFamily="Overpass, sans-serif" fontWeight="900" fontSize="12" fill="#2F4A3A">
        204
      </text>
    </g>
  );
}

function Elevator() {
  return (
    <g>
      <rect x="0" y="34" width="40" height="74" rx="3" fill="none" stroke={PAPER} strokeWidth="5" />
      <line x1="20" y1="34" x2="20" y2="108" stroke={PAPER} strokeWidth="3" />
      <path d="M20 6 L28 18 H12 Z" fill={PAPER} />
      <path d="M20 30 L28 18 H12 Z" fill={PAPER} opacity="0.5" transform="translate(0 0)" />
    </g>
  );
}

function Booth() {
  return (
    <g>
      <path d="M0 40 L22 18 L44 40" fill="none" stroke={PAPER} strokeWidth="5" strokeLinejoin="round" />
      <rect x="2" y="40" width="40" height="12" fill={CORAL} />
      <rect x="4" y="60" width="36" height="14" rx="2" fill={PAPER} />
      <line x1="8" y1="74" x2="8" y2="108" stroke={PAPER} strokeWidth="5" />
      <line x1="36" y1="74" x2="36" y2="108" stroke={PAPER} strokeWidth="5" />
    </g>
  );
}

function Trailhead() {
  return (
    <g>
      <path d="M0 108 L26 52 L40 78 L48 64 L68 108 Z" fill={PAPER} opacity="0.9" />
      <path d="M26 52 L32 65 L22 65 Z" fill="#2F4A3A" opacity="0.5" />
      <line x1="-8" y1="70" x2="-8" y2="108" stroke={PAPER} strokeWidth="4" />
      <path d="M-20 70 H6 L12 77 L6 84 H-20 Z" fill={CORAL} />
    </g>
  );
}

/** Stairs on a side branch with a cross: the Avoid stairs route goes past them. */
function SkippedStairs() {
  return (
    <g>
      <path d="M150 108 Q165 70 178 66" fill="none" stroke={PAPER} strokeWidth="2.5" strokeDasharray="4 5" opacity="0.6" />
      <path d="M176 70 H188 V58 H200 V46 H212 V34 H224" fill="none" stroke={PAPER} strokeWidth="5" strokeLinejoin="round" opacity="0.7" />
      <circle cx="200" cy="52" r="15" fill="#2F4A3A" stroke={CORAL} strokeWidth="4" />
      <path d="M192 44 L208 60 M208 44 L192 60" stroke={CORAL} strokeWidth="4" strokeLinecap="round" />
    </g>
  );
}

/* ---------------------------------------------------------------- rows */

interface Row {
  id: string;
  who: string;
  title: string;
  body: string;
  destination: string;
  figure: ReactNode;
  place: ReactNode;
  wheels?: boolean;
  extra?: ReactNode;
}

const ROWS: Row[] = [
  {
    id: "students",
    who: "Students",
    title: "Find Room 204 before the exam starts.",
    body: "Open a community map of your campus, pick the room, and walk in already knowing the way.",
    destination: "Room 204",
    figure: <Student />,
    place: <Door />,
  },
  {
    id: "step-free",
    who: "People who use a wheelchair or avoid stairs",
    title: "Know it works for you before you leave home.",
    body: "Look around the real place first. Switch on Avoid stairs and the route goes by the elevator or ramp, with no searching.",
    destination: "Elevator",
    figure: <WheelchairUser />,
    place: <Elevator />,
    wheels: true,
    extra: <SkippedStairs />,
  },
  {
    id: "events",
    who: "Event teams",
    title: "Label the venue your way.",
    body: "Scan your venue or start from a map someone already shared, then name the rooms: Workshop room, Sponsor booth, Info desk. Guests open it from a QR code at the door.",
    destination: "Sponsor booth",
    figure: <EventTeam />,
    place: <Booth />,
  },
  {
    id: "explorers",
    who: "Explorers",
    title: "Share the places you know.",
    body: "Map a trail, a park or a favorite building, and publish it to Community for the next person who goes.",
    destination: "Trailhead",
    figure: <Explorer />,
    place: <Trailhead />,
  },
];

function Scene({ row, run }: { row: Row; run: number }) {
  return (
    <svg viewBox="0 0 360 120" className="w-full" aria-hidden="true">
      <line x1="10" y1="110" x2="350" y2="110" stroke={PAPER} strokeOpacity="0.25" strokeWidth="2" />
      <line x1="40" y1="110" x2="270" y2="110" stroke={CORAL} strokeWidth="4" strokeLinecap="round" strokeDasharray="2 10" />
      {row.extra}
      <g transform="translate(286 0)">{row.place}</g>
      <g transform="translate(34 0)">
        {run > 0 ? (
          <g key={run} className={`pg-walker ${row.wheels ? "pg-rolling" : "pg-walking"}`}>
            {row.figure}
          </g>
        ) : (
          <g>{row.figure}</g>
        )}
      </g>
    </svg>
  );
}

function SignRow({ row, first }: { row: Row; first: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  const [run, setRun] = useState(0);

  // Walk once when the row comes into view.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setRun((n) => (n === 0 ? 1 : n));
          observer.disconnect();
        }
      },
      { threshold: 0.6 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <li
      ref={ref}
      onPointerEnter={() => setRun((n) => n + 1)}
      className={`grid items-center gap-4 px-5 py-6 sm:px-8 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-10 xl-text:md:grid-cols-1 ${
        first ? "" : "border-t-2 border-paper/25"
      }`}
    >
      <div>
        <p className="font-mono text-sm tracking-wide text-sage uppercase">{row.who}</p>
        <h3 className="mt-1 font-display text-2xl leading-tight font-black text-balance sm:text-3xl">{row.title}</h3>
        <p className="mt-2 text-lg leading-snug text-paper/90">{row.body}</p>
      </div>
      <div>
        <Scene row={row} run={run} />
        <p className="mt-1 text-right font-display text-lg font-black tracking-wide">
          {row.destination} <span aria-hidden="true">→</span>
        </p>
      </div>
    </li>
  );
}

export default function WhoUses() {
  return (
    <section id="who" aria-labelledby="who-heading" className="bg-paper py-20 md:py-28">
      <Container>
        <div className="grid max-w-3xl gap-3">
          <Eyebrow>Who it's for</Eyebrow>
          <h2 id="who-heading" className="font-display text-4xl leading-none font-black text-balance md:text-5xl">
            One app. A lot of different trips.
          </h2>
          <p className="text-xl leading-relaxed text-muted">
            Anyone can make a map, and anyone can follow one. The same map of a building helps a first-year find a lecture
            hall and a wheelchair user find the elevator.
          </p>
        </div>

        <div data-surface="forest" className="mt-10 rounded-[1.75rem] bg-forest p-2 text-paper shadow-[0_30px_60px_-35px_rgb(18_28_22/0.8)]">
          <ul className="rounded-[1.4rem] ring-2 ring-paper/70">
            {ROWS.map((row, i) => (
              <SignRow key={row.id} row={row} first={i === 0} />
            ))}
          </ul>
        </div>
      </Container>
    </section>
  );
}
