import { QRCodeSVG } from "qrcode.react";
import { useRef, type ReactNode } from "react";
import { useReducedMotion } from "../lib/preferences";
import { gsap, useGSAP, WIDE } from "./motion";
import { Container, Eyebrow } from "./shared";

/*
 * "What you can do in Path": a phone (drawn in CSS 3D, no model file) turns as you
 * scroll while its screen steps through the real app: scan, add waypoints, share,
 * Community, follow a route. The steps sit on a transit-line stepper whose coral
 * line fills as you go. Screens are small HTML versions of the app's pages.
 */

const STEPS = [
  {
    title: "Scan a place",
    body: "Walk it with a LiDAR iPhone. The scan becomes a 3D point cloud you upload as a new map.",
  },
  {
    title: "Add waypoints and name rooms",
    body: "Drop waypoints along the walkable paths and label what matters: Workshop room, Room 204, Elevator.",
  },
  {
    title: "Share it your way",
    body: "Public lists it in Community, Unlisted works for anyone with the link, Private is only for people you invite. Share a link or a QR code.",
  },
  {
    title: "Explore Community",
    body: "Open maps other people have shared: campuses, buildings, trails and event venues. No account needed to look.",
  },
  {
    title: "Follow the route",
    body: "Pick a destination and follow the coral line. Switch on Avoid stairs for this trip and it takes the elevator or ramp.",
  },
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
        <p className="text-[0.7rem] leading-tight font-bold">Take the elevator, then turn left at the amber door</p>
        <p className="font-mono text-[0.55rem] text-muted">Approved by the map owner</p>
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

function Phone({ animate }: { animate: boolean }) {
  const pose = POSES[POSES.length - 1]!;
  return (
    <div className="[perspective:1400px]">
      <div
        data-part="phone"
        className="relative mx-auto aspect-[9/19] w-[min(16rem,62vw)] rounded-[2.6rem] bg-[#0A100C] p-2.5 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.75),inset_0_0_0_1px_rgb(169_196_174/0.25)] [transform-style:preserve-3d] max-md:w-[min(13rem,46vw)]"
        style={{ transform: `rotateY(${pose.rotateY}deg) rotateX(${pose.rotateX}deg) rotateZ(${pose.rotateZ}deg)` }}
      >
        {/* Side edge so the turn reads as a solid object. */}
        <div className="absolute inset-y-6 -left-1 w-1.5 rounded-l-full bg-[#1B2A21]" aria-hidden="true" />
        <div className="relative size-full overflow-hidden rounded-[2rem] bg-night" aria-hidden="true">
          {SCREENS.map((screen, i) => (
            <div
              key={i}
              data-part="screen"
              className="absolute inset-0"
              style={animate ? undefined : { opacity: i === SCREENS.length - 1 ? 1 : 0 }}
            >
              {screen}
            </div>
          ))}
          <div className="absolute top-2 left-1/2 h-5 w-20 -translate-x-1/2 rounded-full bg-black" />
          {/* Glare that slides across as the phone turns. */}
          <div data-part="glare" className="pointer-events-none absolute -inset-1/2 bg-[linear-gradient(115deg,transparent_40%,rgb(255_255_255/0.09)_50%,transparent_60%)]" />
        </div>
      </div>
    </div>
  );
}

export default function AppTour() {
  const reduce = useReducedMotion();
  const animate = !reduce;
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (!animate || !root.current) return;
      const q = gsap.utils.selector(root);
      const phone = q("[data-part=phone]")[0];
      const screens = q("[data-part=screen]");
      const steps = q("[data-part=step]");
      const fill = q("[data-part=line-fill]");
      const stations = q("[data-part=station]");
      const stationsM = q("[data-part=station-m]");
      if (!phone) return;
      const navOffset = () => document.querySelector("header")?.getBoundingClientRect().height ?? 0;
      const mm = gsap.matchMedia();

      mm.add({ wide: WIDE, narrow: "(max-width: 767.98px)" }, (context) => {
        const wide = Boolean(context.conditions?.wide);
        const off = wide ? { opacity: 0.35 } : { autoAlpha: 0, y: 14 };
        const on = wide ? { opacity: 1 } : { autoAlpha: 1, y: 0 };

        gsap.set(screens, { autoAlpha: (i: number) => (i === 0 ? 1 : 0), xPercent: 0 });
        gsap.set(steps.slice(1), off);
        gsap.set(steps[0]!, on);
        gsap.set(phone, POSES[0]!);
        gsap.set(fill, { scaleY: 0, scaleX: 0 });
        gsap.set([...stations, ...stationsM], { backgroundColor: "#3A4A40" });
        gsap.set([stations[0]!, stationsM[0]!], { backgroundColor: "#F48057" });
        gsap.set(q("[data-part=glare]"), { xPercent: -40 });

        const tl = gsap.timeline({
          defaults: { ease: "none" },
          scrollTrigger: {
            trigger: root.current,
            start: () => `top ${navOffset()}`,
            end: `+=${STEPS.length * 70}%`,
            pin: true,
            scrub: 0.7,
            invalidateOnRefresh: true,
          },
        });

        for (let i = 1; i < STEPS.length; i++) {
          const at = i;
          tl.to(phone, { ...POSES[i]!, duration: 0.6, ease: "power2.inOut" }, at - 0.1)
            .to(q("[data-part=glare]"), { xPercent: i % 2 ? 40 : -40, duration: 0.6, ease: "power1.inOut" }, at - 0.1)
            .to(screens[i - 1]!, { autoAlpha: 0, xPercent: -12, duration: 0.3 }, at)
            .fromTo(screens[i]!, { autoAlpha: 0, xPercent: 12 }, { autoAlpha: 1, xPercent: 0, duration: 0.3 }, at)
            .to(steps[i - 1]!, { ...off, duration: 0.3 }, at)
            .to(steps[i]!, { ...on, duration: 0.3 }, at)
            .to([stations[i]!, stationsM[i]!], { backgroundColor: "#F48057", duration: 0.1 }, at + 0.2);
        }
        tl.to(fill, wide ? { scaleY: 1, duration: STEPS.length - 1 } : { scaleX: 1, duration: STEPS.length - 1 }, 0.2);
        tl.to({}, { duration: 0.5 });
      });
    },
    { scope: root, dependencies: [animate], revertOnUpdate: true },
  );

  return (
    <section
      ref={root}
      id="tour"
      aria-labelledby="tour-heading"
      data-surface="night"
      className="relative overflow-hidden bg-night py-16 text-paper md:flex md:min-h-[calc(100dvh-4.5rem)] md:items-center md:py-10"
    >
      <Container className="grid items-center gap-8 md:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] md:gap-14">
        <div className="grid gap-6">
          <div className="grid gap-2">
            <Eyebrow tone="dark">What you can do in Path</Eyebrow>
            <h2 id="tour-heading" className="font-display text-4xl leading-none font-black text-balance md:text-5xl">
              Make a map. Share it. Follow it.
            </h2>
          </div>

          <div className="relative">
            {/* Transit line: on wide screens it runs down beside the steps, on phones across the top. */}
            <div className="absolute top-3 bottom-3 left-[0.6875rem] w-1 rounded-full bg-sage/25 max-md:hidden" aria-hidden="true">
              <div data-part="line-fill" className="h-full w-full origin-top rounded-full bg-coral" />
            </div>
            <div className="relative mb-4 flex items-center justify-between md:hidden" aria-hidden="true">
              <div className="absolute inset-x-1 top-1/2 h-1 -translate-y-1/2 rounded-full bg-sage/25">
                <div data-part="line-fill" className="h-full w-full origin-left rounded-full bg-coral" />
              </div>
              {STEPS.map((s) => (
                <span key={s.title} data-part="station-m" className="relative size-4 rounded-full bg-coral ring-4 ring-night" />
              ))}
            </div>
            <ol className={animate ? "grid max-md:[&>li]:col-start-1 max-md:[&>li]:row-start-1 md:gap-5" : "grid gap-5"}>
              {STEPS.map((step, i) => (
                <li key={step.title} data-part="step" className="relative grid grid-cols-[1.5rem_1fr] gap-4 max-md:grid-cols-1">
                  <span
                    data-part="station"
                    aria-hidden="true"
                    className="relative mt-1 size-6 rounded-full bg-coral ring-4 ring-night max-md:hidden"
                  />
                  <div>
                    <h3 className="font-display text-2xl leading-tight font-black">
                      <span className="mr-2 font-mono text-base font-normal text-sage">0{i + 1}</span>
                      {step.title}
                    </h3>
                    <p className="mt-1 max-w-prose text-lg leading-snug text-paper/85">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="max-md:order-first">
          <Phone animate={animate} />
        </div>
      </Container>
    </section>
  );
}
