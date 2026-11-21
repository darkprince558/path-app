import { ArrowRight, RotateCcw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useReducedMotion } from "../lib/preferences";
import { demoUrl, isLocalhost } from "./shared";
import { DESTINATIONS, type DestinationId } from "./venue";

// three.js loads in its own chunk after the text, so the headline paints right away.
const HeroScene = lazy(() => import("./HeroScene"));

/** The booth laptop replays the intro after this long without anyone touching it. */
const IDLE_REPLAY_MS = 20_000;

/** Faint dots in the night sky behind the headline. Seeded, so they don't jump on reload. */
function Stars() {
  const stars = useMemo(() => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: 70 }, (_, i) => ({ x: rand() * 100, y: rand() * 70, r: rand() < 0.15 ? 1.6 : 1, twinkle: i % 5 === 0 }));
  }, []);
  return (
    <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
      {stars.map((s, i) => (
        <circle
          key={i}
          cx={`${s.x}%`}
          cy={`${s.y}%`}
          r={s.r}
          fill="#F3EBD0"
          opacity={s.twinkle ? undefined : 0.35}
          className={s.twinkle ? "hero-twinkle" : undefined}
          style={s.twinkle ? { animationDelay: `${(i % 7) * 0.6}s` } : undefined}
        />
      ))}
    </svg>
  );
}

/** Frosted panel that floats over the scan. */
const GLASS =
  "rounded-2xl bg-[#1B2A21]/55 p-4 text-paper shadow-[0_20px_50px_-20px_rgb(0_0_0/0.8)] ring-1 ring-sage/20 backdrop-blur-md";

export default function Hero() {
  const reduce = useReducedMotion();
  const [destination, setDestination] = useState<DestinationId>("workshop");
  const [replayToken, setReplayToken] = useState(0);
  const [active, setActive] = useState(true);
  const viewer = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLParagraphElement>(null);

  const onReadout = useCallback((text: string) => {
    if (readout.current) readout.current.textContent = text;
  }, []);

  // Stop drawing frames while the hero is scrolled away.
  useEffect(() => {
    const element = viewer.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setActive(Boolean(entry?.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Idle replay for the booth. Any pointer, key or scroll resets the timer.
  useEffect(() => {
    if (reduce || !active) return;
    let timer = window.setTimeout(replay, IDLE_REPLAY_MS);
    function replay() {
      setReplayToken((n) => n + 1);
      timer = window.setTimeout(replay, IDLE_REPLAY_MS);
    }
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(replay, IDLE_REPLAY_MS);
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "scroll"] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [reduce, active]);

  useEffect(() => {
    if (import.meta.env.DEV && !import.meta.env.VITE_DEMO_SHARE_URL && isLocalhost()) {
      console.info("Landing QR points at localhost. Set VITE_DEMO_SHARE_URL to a hosted guest link for phones.");
    }
  }, []);

  return (
    <section
      aria-labelledby="hero-heading"
      data-surface="night"
      className="relative isolate -mt-[4.25rem] overflow-hidden bg-night pt-[4.25rem] text-paper md:min-h-dvh"
    >
      {/* Soft light: forest from the top left, a coral warmth where the route lives. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(55%_45%_at_12%_0%,rgb(47_74_58/0.95),transparent_70%),radial-gradient(40%_35%_at_88%_10%,rgb(47_74_58/0.5),transparent_70%),radial-gradient(45%_35%_at_50%_88%,rgb(244_128_87/0.14),transparent_70%)]"
      />
      <Stars />

      <div className="relative z-10 mx-auto grid max-w-4xl justify-items-center gap-6 px-4 pt-14 text-center sm:pt-20">
        <h1 id="hero-heading" className="font-display text-[clamp(2.75rem,7vw,5.5rem)] leading-[0.95] font-black tracking-tight text-balance">
          See the turn before you reach it.
        </h1>
        <p className="max-w-xl text-lg leading-relaxed text-sage sm:text-xl">
          3D maps of real places, made by the people who know them. Open one from a link, with no app and no account.
        </p>
        <div className="flex flex-col items-center gap-x-6 gap-y-2 sm:flex-row">
          <Link
            to="/maps/new"
            className="inline-flex min-h-13 items-center justify-center rounded-full bg-paper px-7 text-lg font-bold text-ink shadow-[0_10px_40px_-10px_rgb(243_235_208/0.45)] transition-transform hover:-translate-y-0.5"
          >
            Start mapping
          </Link>
          <Link to="/community" className="inline-flex min-h-11 items-center gap-1.5 font-bold text-sage underline-offset-4 hover:text-paper hover:underline">
            Explore community maps <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </div>

      {/* The scan: full width, rising from the bottom edge, fading into the sky at the top. */}
      <div className="relative -mt-6 md:absolute md:inset-x-0 md:bottom-0 md:mt-0 md:h-[56%]">
        <div
          ref={viewer}
          role="img"
          aria-label="A 3D scan of a T-shaped corridor. A coral route runs from the entrance to the junction, then to the chosen room, with footprints along it and a pin at the door."
          className="relative h-[22rem] w-full [mask-image:linear-gradient(to_bottom,transparent,black_35%)] sm:h-[28rem] md:h-full"
        >
          <Suspense fallback={null}>
            <HeroScene destination={destination} replayToken={replayToken} reduceMotion={reduce} active={active} onReadout={onReadout} />
          </Suspense>
        </div>

        {/* Floating panel, left: choose where the route goes. */}
        <div className={`hero-float relative z-10 mx-4 -mt-10 grid gap-3 sm:mx-auto sm:w-fit md:absolute md:bottom-[30%] md:left-[max(1.5rem,calc(50%-34rem))] md:mx-0 md:mt-0 ${GLASS}`}>
          <div className="flex items-center justify-between gap-6">
            <p id="route-to" className="text-sm text-sage">
              Route to
            </p>
            <button
              type="button"
              onClick={() => setReplayToken((n) => n + 1)}
              aria-label="Replay the intro"
              className="grid size-9 place-items-center rounded-full bg-paper text-ink transition-transform hover:rotate-[-30deg]"
            >
              <RotateCcw className="size-4" aria-hidden />
            </button>
          </div>
          <div role="group" aria-labelledby="route-to" className="flex flex-wrap gap-2">
            {DESTINATIONS.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={destination === d.id}
                onClick={() => setDestination(d.id)}
                className="min-h-11 rounded-full px-4 font-bold text-paper ring-1 ring-paper/30 transition-colors hover:bg-paper/10 aria-pressed:bg-coral aria-pressed:text-ink aria-pressed:ring-coral"
              >
                {d.label}
              </button>
            ))}
          </div>
          <p ref={readout} aria-hidden="true" className="font-mono text-xs text-sage">
            entrance · 0.0 m
          </p>
        </div>

        {/* Floating panel, right: open the sample map on a phone. Hidden on phones, which are already there. */}
        <figure
          className={`hero-float hero-float-late absolute right-[max(1.5rem,calc(50%-34rem))] bottom-[14%] z-10 hidden items-center gap-4 md:flex ${GLASS}`}
        >
          <div className="rounded-lg bg-paper p-1.5">
            <QRCodeSVG value={demoUrl()} size={76} bgColor="#F3EBD0" fgColor="#15221B" level="M" title="QR code for a sample map" />
          </div>
          <figcaption className="max-w-[9rem] text-left leading-snug">
            <span className="block font-bold">Try it on your phone</span>
            <span className="text-sm text-sage">Scan to open a sample map</span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
