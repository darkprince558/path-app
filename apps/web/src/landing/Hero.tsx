import { RotateCcw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../lib/preferences";
import { Container, DemoQr, Eyebrow, PrimaryLink, SecondaryLink } from "./shared";
import { DESTINATIONS, type DestinationId } from "./venue";

// three.js loads in its own chunk after the text, so the headline paints right away.
const HeroScene = lazy(() => import("./HeroScene"));

/** The booth laptop replays the intro after this long without anyone touching it. */
const IDLE_REPLAY_MS = 20_000;

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

  return (
    <section aria-labelledby="hero-heading" data-surface="night" className="relative overflow-hidden bg-night text-paper">
      <Container className="grid items-center gap-10 pt-10 pb-16 lg:grid-cols-[5fr_7fr] lg:pt-16 lg:pb-24 xl-text:lg:grid-cols-1">
        <div className="grid gap-6">
          <Eyebrow tone="dark">3D maps for any place</Eyebrow>
          <h1 id="hero-heading" className="font-display text-5xl leading-[0.95] font-black tracking-tight text-balance sm:text-6xl">
            See the turn{" "}
            <span className="underline decoration-coral decoration-[0.14em] underline-offset-[0.14em]">before</span> you
            reach it.
          </h1>
          <p className="max-w-xl text-xl leading-relaxed text-paper/90">
            Path turns a phone scan into a 3D map anyone can open from a link. Map your campus, building, trail or event,
            or find one the community already shared, and follow the route to the right door.
          </p>
          <div className="flex flex-wrap gap-3">
            <PrimaryLink to="/maps/new">Start mapping</PrimaryLink>
            <SecondaryLink to="/community" tone="dark">
              Explore community maps
            </SecondaryLink>
          </div>
          <DemoQr
            caption={
              <>
                <strong className="block font-bold">Try it on your phone</strong>
                <span className="text-sage">Scan to open a sample map. No app, no account.</span>
              </>
            }
          />
        </div>

        <div>
          <div className="relative">
          <div
            ref={viewer}
            role="img"
            aria-label="A 3D scan of a T-shaped corridor. A coral route runs from the entrance to the junction, then to the chosen room, with footprints along it and a pin at the door."
            className="relative aspect-square overflow-hidden rounded-3xl bg-[radial-gradient(120%_90%_at_50%_20%,#1C2C22_0%,#121C16_70%)] ring-1 ring-sage/15 sm:aspect-[4/3]"
          >
            <Suspense fallback={<p className="absolute inset-0 grid place-items-center font-mono text-sm text-sage">Loading the scan…</p>}>
              <HeroScene
                destination={destination}
                replayToken={replayToken}
                reduceMotion={reduce}
                active={active}
                onReadout={onReadout}
              />
            </Suspense>
          </div>
          <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start justify-between gap-2">
            <div role="group" aria-label="Show the route to" className="pointer-events-auto flex flex-wrap gap-2">
              {DESTINATIONS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={destination === d.id}
                  onClick={() => setDestination(d.id)}
                  className="min-h-11 rounded-full bg-night/80 px-4 text-sm font-bold text-paper ring-1 ring-paper/30 backdrop-blur transition-colors aria-pressed:bg-coral aria-pressed:text-ink aria-pressed:ring-coral"
                >
                  {d.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setReplayToken((n) => n + 1)}
              className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full bg-night/80 px-4 text-sm font-bold text-paper ring-1 ring-paper/30 backdrop-blur"
            >
              <RotateCcw className="size-4" aria-hidden />
              Replay
            </button>
          </div>
          <p
            ref={readout}
            aria-hidden="true"
            className="pointer-events-none absolute bottom-3 left-4 font-mono text-xs text-sage"
          >
            entrance (0.0, 0.0, 0.0) m
          </p>
          </div>
          <p className="mt-3 font-mono text-xs text-sage">
            Synthetic venue in meters, same layout as the repo fixture. Drag with a mouse to turn it.
          </p>
        </div>
      </Container>
    </section>
  );
}
