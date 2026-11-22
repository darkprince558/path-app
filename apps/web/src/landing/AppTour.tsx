import { QRCodeSVG } from "qrcode.react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "../lib/preferences";
import { Container } from "./shared";

/*
 * "How it works": a phone (drawn in CSS 3D, no model file) shows the real app one
 * step at a time: scan, add waypoints, share, Community, follow a route. Nothing is
 * pinned, so the page always scrolls freely.
 *   Laptop: the phone stays beside the steps (CSS sticky) and turns to the step in
 *   the middle of the screen.
 *   Phone: each step is a row with its own small phone, alternating sides, and the
 *   rows slide in as you reach them.
 * Screens are small HTML versions of the app's pages.
 */

const STEPS = [
  { title: "Scan a place", body: "Log in and walk it with a LiDAR iPhone." },
  { title: "Add waypoints", body: "Pin the rooms that matter: Room 204, Elevator, Workshop." },
  { title: "Share it", body: "Public, Unlisted or Private, by link or QR code." },
  { title: "Explore Community", body: "Open maps other people have shared. No account needed." },
  { title: "Follow the route", body: "Pick a room. Switch on Avoid stairs if you need to." },
];

/** How the phone is turned for each step (degrees). */
const POSES = [
  { rotateY: -24, rotateX: 8, rotateZ: -2 },
  { rotateY: 18, rotateX: 6, rotateZ: 2 },
  { rotateY: -14, rotateX: 10, rotateZ: -1 },
  { rotateY: 20, rotateX: 4, rotateZ: 2 },
  { rotateY: -8, rotateX: 6, rotateZ: 0 },
];

/* ----------------------------------------------------------- screens */

function ScreenTop({ title, dark = true }: { title: string; dark?: boolean }) {
  return (
    <div className={`flex items-center justify-between px-4 pt-7 pb-2 text-[0.7rem] font-bold ${dark ? "text-paper" : "text-forest"}`}>
      <span className="font-display text-sm font-black">{title}</span>
      <span className="font-mono opacity-70">9:41</span>
    </div>
  );
}

/** Dots of the T corridor, seen from above, for the scan and waypoint screens. */
const DOTS = Array.from({ length: 220 }, (_, i) => {
  const r = Math.sin(i * 12.9898) * 43758.5453;
  const u = r - Math.floor(r);
  const v = (Math.sin(i * 78.233) * 12345.678) % 1;
  const w = Math.abs(v);
  // Corridor (stem) then the cross hall.
  return i % 3 === 0 ? { x: 40 + u * 20, y: 30 + w * 60 } : { x: 6 + u * 88, y: 82 + w * 16 };
});

function ScanScreen() {
  return (
    <div className="absolute inset-0 bg-night">
      <ScreenTop title="New scan" />
      <svg viewBox="0 0 100 110" className="absolute inset-x-4 top-16 bottom-24" aria-hidden="true">
        {DOTS.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r="0.9" fill={i % 7 === 0 ? "#ECAC3A" : "#D6CEB8"} opacity={0.85} />
        ))}
        <rect className="tour-scanline" x="0" y="20" width="100" height="2" fill="#F48057" opacity="0.8" />
      </svg>
      <div className="absolute inset-x-0 bottom-6 grid justify-items-center gap-2">
        <p className="font-mono text-[0.65rem] text-sage">12,480 points · 0:42</p>
        <span className="grid size-12 place-items-center rounded-full ring-4 ring-paper/70">
          <span className="size-5 rounded-sm bg-coral" />
        </span>
      </div>
    </div>
  );
}

function WaypointScreen() {
  return (
    <div className="absolute inset-0 bg-night">
      <ScreenTop title="Waypoints" />
      <svg viewBox="0 0 100 110" className="absolute inset-x-4 top-16 bottom-28" aria-hidden="true">
        {DOTS.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r="0.7" fill="#A9C4AE" opacity={0.35} />
        ))}
        <path d="M50 92 V40 M50 90 H15 M50 90 H85" stroke="#F48057" strokeWidth="1.4" strokeDasharray="2 2" fill="none" />
        {[
          [50, 40],
          [50, 90],
          [15, 90],
          [85, 90],
        ].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="3.2" fill="#F48057" stroke="#121C16" strokeWidth="1.2" />
        ))}
      </svg>
      <div className="absolute inset-x-3 bottom-4 grid gap-1.5">
        {["Workshop room", "Info booth", "Elevator"].map((label, i) => (
          <div key={label} className="flex items-center justify-between rounded-lg bg-paper px-3 py-1.5 text-[0.7rem] font-bold text-ink">
            {label}
            <span className="font-mono font-normal text-muted">{["W3", "W4", "W2"][i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShareScreen() {
  return (
    <div className="absolute inset-0 bg-paper text-forest">
      <ScreenTop title="Share map" dark={false} />
      <div className="grid gap-3 px-3">
        <div className="grid grid-cols-3 rounded-full bg-surface p-1 text-center text-[0.65rem] font-bold ring-1 ring-forest/15">
          <span className="rounded-full py-1.5">Public</span>
          <span className="rounded-full bg-forest py-1.5 text-paper">Unlisted</span>
          <span className="rounded-full py-1.5">Private</span>
        </div>
        <p className="text-[0.65rem] leading-snug text-muted">Anyone with the link can open it. It isn't listed in Community.</p>
        <div className="mx-auto rounded-xl bg-surface p-2 ring-1 ring-forest/15">
          <QRCodeSVG value="https://path.example/s/7Kq2" size={96} bgColor="#FAF5E6" fgColor="#15221B" aria-hidden="true" />
        </div>
        <div className="flex items-center justify-between rounded-lg bg-surface px-2.5 py-2 font-mono text-[0.6rem] ring-1 ring-forest/15">
          …/s/7Kq2Xb
          <span className="rounded-full bg-coral px-2 py-1 font-sans font-bold text-ink">Copy</span>
        </div>
      </div>
    </div>
  );
}

const COMMUNITY = [
  { name: "Science building, floor 2", kind: "Campus", hue: "#ECAC3A" },
  { name: "River trail loop", kind: "Trail", hue: "#78D296" },
  { name: "Hackathon venue", kind: "Event", hue: "#F48057" },
  { name: "Main library", kind: "Building", hue: "#9664C8" },
];

function CommunityScreen() {
  return (
    <div className="absolute inset-0 bg-paper text-forest">
      <ScreenTop title="Community" dark={false} />
      <div className="flex gap-1 px-3 pb-2 text-[0.6rem] font-bold">
        {["All", "Campus", "Trails", "Step-free"].map((chip, i) => (
          <span key={chip} className={`rounded-full px-2 py-1 ${i === 0 ? "bg-forest text-paper" : "ring-1 ring-forest/25"}`}>
            {chip}
          </span>
        ))}
      </div>
      <div className="grid gap-2 px-3">
        {COMMUNITY.map((m, i) => (
          <div key={m.name} className="flex items-center gap-2 rounded-xl bg-surface p-2 ring-1 ring-forest/10">
            <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-night">
              <svg viewBox="0 0 20 20" className="size-8" aria-hidden="true">
                {Array.from({ length: 18 }, (_, k) => (
                  <circle key={k} cx={3 + ((k * 7 + i * 3) % 15)} cy={4 + ((k * 5 + i) % 12)} r="0.9" fill={k % 4 ? "#D6CEB8" : m.hue} />
                ))}
              </svg>
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[0.7rem] font-bold">{m.name}</span>
              <span className="text-[0.6rem] text-muted">{m.kind}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RouteScreen() {
  return (
    <div className="absolute inset-0 bg-night">
      <ScreenTop title="Science building" />
      <svg viewBox="0 0 100 120" className="absolute inset-x-2 top-12 bottom-36" aria-hidden="true">
        {DOTS.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y + 6} r="0.8" fill="#D6CEB8" opacity={0.55} />
        ))}
        <path className="tour-route" d="M50 102 V96 H18" stroke="#F48057" strokeWidth="2.4" strokeLinecap="round" fill="none" strokeDasharray="3 3" />
        <path d="M50 102 V50" stroke="#F48057" strokeWidth="0.8" strokeDasharray="1 2" fill="none" opacity="0.5" />
        <circle cx="18" cy="96" r="3.5" fill="#F48057" />
        <circle cx="50" cy="102" r="3" fill="#78D296" />
      </svg>
      <div className="absolute inset-x-3 top-20 rounded-xl bg-paper px-3 py-2 text-ink shadow-lg">
        <p className="text-[0.7rem] leading-tight font-bold">Turn left at the amber door</p>
      </div>
      <div className="absolute inset-x-0 bottom-0 grid gap-1.5 rounded-t-2xl bg-paper px-3 pt-2 pb-4 text-ink">
        <span className="mx-auto h-1 w-8 rounded-full bg-ink/25" />
        <div className="flex items-center justify-between text-[0.75rem] font-bold">
          Workshop room
          <span className="font-mono text-[0.6rem] font-normal text-forest">9 m</span>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-surface px-2 py-1.5 text-[0.65rem] font-bold ring-1 ring-forest/15">
          Avoid stairs
          <span className="flex h-4 w-7 items-center justify-end rounded-full bg-forest p-0.5">
            <span className="size-3 rounded-full bg-paper" />
          </span>
        </div>
      </div>
    </div>
  );
}

const SCREENS: ReactNode[] = [<ScanScreen />, <WaypointScreen />, <ShareScreen />, <CommunityScreen />, <RouteScreen />];

/* ------------------------------------------------------------- phone */

/** Phone size the screens are drawn for. Smaller phones are this, scaled down. */
const PHONE_REM = 15;

function usePose(step: number, side?: "left" | "right") {
  const pose = POSES[step] ?? POSES[0]!;
  // On the phone layout, each little phone turns toward its text.
  const rotateY = side ? (side === "left" ? 12 : -12) : pose.rotateY;
  return `rotateY(${rotateY}deg) rotateX(${pose.rotateX}deg) rotateZ(${side ? 0 : pose.rotateZ}deg)`;
}

/**
 * The phone. `step` picks the screen; screens cross-fade and the phone turns, both
 * with CSS transitions (instant under Reduce motion). It fills its box's width,
 * scaling the 15rem design down when the box is narrower.
 */
function Phone({ step, side }: { step: number; side?: "left" | "right" }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const transform = usePose(step, side);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setScale(Math.min(1, element.clientWidth / (PHONE_REM * rem)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={box} className="w-full [perspective:1400px]" style={{ height: `calc(${PHONE_REM * (19 / 9) * scale}rem + 0px)` }}>
      <div
        className="relative aspect-[9/19] origin-top-left rounded-[2.6rem] bg-[#0A100C] p-2.5 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.75),inset_0_0_0_1px_rgb(169_196_174/0.25)] transition-transform duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] [transform-style:preserve-3d]"
        style={{ width: `${PHONE_REM}rem`, transform: `${scale < 1 ? `scale(${scale}) ` : ""}${transform}` }}
      >
        <div className="absolute inset-y-6 -left-1 w-1.5 rounded-l-full bg-[#1B2A21]" aria-hidden="true" />
        <div className="relative size-full overflow-hidden rounded-[2rem] bg-night" aria-hidden="true">
          {SCREENS.map((screen, i) =>
            side && i !== step ? null : (
              <div
                key={i}
                className="absolute inset-0 transition-[opacity,translate] duration-500"
                style={{ opacity: i === step ? 1 : 0, translate: i === step ? "0 0" : i < step ? "-10% 0" : "10% 0" }}
              >
                {screen}
              </div>
            ),
          )}
          <div className="absolute top-2 left-1/2 h-5 w-20 -translate-x-1/2 rounded-full bg-black" />
          <div className="pointer-events-none absolute -inset-1/2 bg-[linear-gradient(115deg,transparent_40%,rgb(255_255_255/0.08)_50%,transparent_60%)]" />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- laptop layout */

/** Steps on the left scroll past; the phone on the right stays and shows the one in the middle. */
function WideTour() {
  const [active, setActive] = useState(0);
  const items = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.step));
        }
      },
      // A thin band across the middle of the screen: whichever step crosses it is current.
      { rootMargin: "-48% 0px -48% 0px" },
    );
    items.current.forEach((item) => item && observer.observe(item));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-12">
      <ol className="py-[18vh]">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            ref={(el) => {
              items.current[i] = el;
            }}
            data-step={i}
            className="flex min-h-[42vh] items-center"
          >
            <div className={`transition-opacity duration-500 ${i === active ? "opacity-100" : "opacity-60"}`}>
              <p className="font-mono text-sm text-sage">0{i + 1}</p>
              <h3 className="mt-1 font-display text-4xl leading-tight font-black">{step.title}</h3>
              <p className="mt-2 max-w-md text-xl leading-snug text-paper/90">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div>
        <div className="sticky top-[max(5.5rem,calc(50vh-17rem))] mx-auto w-[15rem]">
          <Phone step={active} />
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- phone layout */

/** One row per step, alternating sides, sliding in from its own side when reached. */
function StackedTour({ reduce }: { reduce: boolean }) {
  return (
    <ol className="grid gap-10">
      {STEPS.map((step, i) => (
        <StackedRow key={step.title} index={i} reduce={reduce} />
      ))}
    </ol>
  );
}

function StackedRow({ index, reduce }: { index: number; reduce: boolean }) {
  const step = STEPS[index]!;
  const textLeft = index % 2 === 1;
  const ref = useRef<HTMLLIElement>(null);
  const [shown, setShown] = useState(reduce);

  useEffect(() => {
    if (reduce) {
      setShown(true);
      return;
    }
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -15% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [reduce]);

  const from = textLeft ? "-2rem" : "2rem";
  return (
    <li ref={ref} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-5 xl-text:grid-cols-1">
      <div
        className={`transition-[opacity,translate] duration-700 ease-out ${textLeft ? "order-last xl-text:order-none" : ""}`}
        style={{ opacity: shown ? 1 : 0, translate: shown ? "0 0" : `${textLeft ? "2rem" : "-2rem"} 0` }}
      >
        <Phone step={index} side={textLeft ? "left" : "right"} />
      </div>
      <div
        className={`transition-[opacity,translate] delay-150 duration-700 ease-out ${textLeft ? "text-right xl-text:text-left" : ""}`}
        style={{ opacity: shown ? 1 : 0, translate: shown ? "0 0" : `${from} 0` }}
      >
        <p className="font-mono text-sm text-sage">0{index + 1}</p>
        <h3 className="mt-1 font-display text-2xl leading-tight font-black">{step.title}</h3>
        <p className="mt-1.5 text-lg leading-snug text-paper/90">{step.body}</p>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------- section */

function useWide() {
  const query = "(min-width: 1024px)";
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setWide(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return wide;
}

export default function AppTour() {
  const reduce = useReducedMotion();
  const wide = useWide();

  return (
    <section id="tour" aria-labelledby="tour-heading" data-surface="night" className="relative bg-night py-28 text-paper md:py-40">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_30%_at_10%_0%,rgb(47_74_58/0.8),transparent_70%),radial-gradient(40%_25%_at_90%_60%,rgb(47_74_58/0.45),transparent_70%)]"
      />
      <Container className="relative">
        <div className="mx-auto grid max-w-2xl gap-3 text-center">
          <h2 id="tour-heading" className="font-display text-[clamp(2rem,3.6vw,3rem)] leading-none font-black text-balance">
            Make a map. Share it. Follow it.
          </h2>
          <p className="text-lg text-sage">Everything happens in the app, from the first scan to the last turn.</p>
        </div>
        <div className="mt-14">{wide ? <WideTour /> : <StackedTour reduce={reduce} />}</div>
      </Container>
    </section>
  );
}
