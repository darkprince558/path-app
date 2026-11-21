import { ArrowUpRight, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";
import { useReducedMotion } from "../lib/preferences";
import { gsap, useGSAP } from "./motion";
import { Container, Eyebrow } from "./shared";

/*
 * Creators: the four cards start stacked in one pile in the middle. As you scroll,
 * two slide out to the left and two to the right into an even row (a 2 × 2 grid on
 * tablets). Each card flips to its links on hover with a mouse, with the Flip button
 * on a phone, and when a link on the back gets keyboard focus.
 */

interface Person {
  name: string;
  initials: string;
  role: string;
  built: string;
  /** Only real links are shown. Add LinkedIn, résumé or portfolio here when you have them. */
  links: { label: string; href: string; detail: string }[];
}

const TEAM: Person[] = [
  {
    name: "Arielle",
    initials: "AB",
    role: "Frontend, 3D viewer and UX",
    built: "This page, the 3D map viewer, sharing screens and accessibility settings.",
    links: [{ label: "GitHub", href: "https://github.com/AryBaum", detail: "AryBaum" }],
  },
  {
    name: "Sam",
    initials: "S",
    role: "Backend and sharing",
    built: "The API: uploads, storage, and Public, Unlisted and Private access.",
    links: [],
  },
  {
    name: "Krishna",
    initials: "K",
    role: "Phone capture",
    built: "LiDAR capture on iPhone and turning the scan into a point cloud.",
    links: [],
  },
  {
    name: "Anish",
    initials: "A",
    role: "Phone capture and testing",
    built: "Capture and upload, and the trial that opens a map on a second phone.",
    links: [],
  },
];

/** Contour lines, like a topographic map, different for each person. */
function Contours({ seed }: { seed: number }) {
  const lines = Array.from({ length: 9 }, (_, i) => {
    const r = 18 + i * 13;
    const wobble = (k: number) => Math.sin(seed * 1.7 + i * 0.9 + k) * (6 + i * 1.5);
    const cx = 60 + Math.sin(seed) * 25;
    const cy = 70 + Math.cos(seed * 2) * 20;
    return `M ${cx - r - wobble(1)} ${cy}
      C ${cx - r} ${cy - r * 0.8 + wobble(2)}, ${cx + r * 0.6} ${cy - r - wobble(3)}, ${cx + r + wobble(4)} ${cy}
      S ${cx - r * 0.4} ${cy + r + wobble(5)}, ${cx - r - wobble(1)} ${cy} Z`;
  });
  return (
    <svg viewBox="0 0 160 200" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 size-full" aria-hidden="true">
      {lines.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="#A9C4AE" strokeOpacity={0.18 + (i % 3) * 0.06} strokeWidth="1.2" />
      ))}
    </svg>
  );
}

function Card({ person, index }: { person: Person; index: number }) {
  const [flipped, setFlipped] = useState(false);
  const backId = `creator-${index}-back`;
  return (
    <li data-part="card" className="relative [perspective:1100px]" style={{ zIndex: TEAM.length - index }}>
      <div
        className={`group/card relative aspect-[3/4] w-full transition-transform duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] [transform-style:preserve-3d] has-[[data-face=back]_:focus-visible]:[transform:rotateY(180deg)] xl-text:aspect-auto xl-text:min-h-[26rem] ${
          flipped ? "[transform:rotateY(180deg)]" : "[@media(hover:hover)]:hover:[transform:rotateY(180deg)]"
        }`}
      >
        {/* Front */}
        <div className="absolute inset-0 grid grid-rows-[1fr_auto] overflow-hidden rounded-3xl bg-forest text-paper shadow-[0_24px_50px_-28px_rgb(0_0_0/0.9)] ring-1 ring-sage/25 [backface-visibility:hidden]">
          <Contours seed={index + 1} />
          <div className="relative grid place-items-center">
            <span className="font-display text-7xl font-black tracking-tight" aria-hidden="true">
              {person.initials}
            </span>
          </div>
          <div className="relative flex items-end justify-between gap-3 bg-night/55 px-5 py-4">
            <div>
              <h3 className="font-display text-2xl leading-none font-black">{person.name}</h3>
              <p className="mt-1 text-sage">{person.role}</p>
            </div>
            <button
              type="button"
              onClick={() => setFlipped(true)}
              aria-controls={backId}
              aria-label={`Flip ${person.name}'s card`}
              className="grid size-11 shrink-0 place-items-center rounded-full bg-paper/10 ring-1 ring-paper/30 [@media(hover:hover)]:hidden"
            >
              <RotateCcw className="size-5" aria-hidden />
            </button>
          </div>
        </div>

        {/* Back */}
        <div
          id={backId}
          data-face="back"
          className="absolute inset-0 grid content-start gap-4 overflow-auto rounded-3xl bg-[#1B2A21] p-5 text-paper ring-1 ring-sage/25 [backface-visibility:hidden] [transform:rotateY(180deg)]"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-display text-2xl leading-none font-black">{person.name}</p>
            {flipped ? (
              <button
                type="button"
                onClick={() => setFlipped(false)}
                aria-label={`Flip ${person.name}'s card back`}
                className="grid size-11 shrink-0 place-items-center rounded-full bg-paper/10 ring-1 ring-paper/30"
              >
                <RotateCcw className="size-5" aria-hidden />
              </button>
            ) : null}
          </div>
          <p className="leading-snug text-paper/90">{person.built}</p>
          {person.links.length ? (
            <ul className="grid gap-2">
              {person.links.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-h-11 items-center justify-between gap-2 rounded-xl bg-night px-4 font-bold transition-colors hover:bg-coral hover:text-ink"
                  >
                    {link.label}
                    <span className="flex items-center gap-1 font-mono text-sm font-normal text-sage">
                      {link.detail}
                      <ArrowUpRight className="size-4" aria-hidden />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="font-mono text-sm text-sage">Links coming soon.</p>
          )}
        </div>
      </div>
    </li>
  );
}

export default function Creators() {
  const reduce = useReducedMotion();
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (reduce || !root.current) return;
      const q = gsap.utils.selector(root);
      const list = q("[data-part=deck]")[0] as HTMLElement | undefined;
      const cards = q("[data-part=card]") as HTMLElement[];
      if (!list || cards.length < 2) return;
      const navOffset = () => document.querySelector("header")?.getBoundingClientRect().height ?? 0;
      const mm = gsap.matchMedia();

      // From 640 px up the cards fit side by side, so they start as one pile.
      mm.add("(min-width: 640px)", () => {
        const tilt = [-7, 4, -3, 6];
        // Offset from each card's final spot to the middle of the row.
        const toCenter = (card: HTMLElement, axis: "x" | "y") => {
          const listBox = list.getBoundingClientRect();
          const box = card.getBoundingClientRect();
          return axis === "x"
            ? listBox.left + listBox.width / 2 - (box.left + box.width / 2)
            : listBox.top + listBox.height / 2 - (box.top + box.height / 2);
        };
        gsap.fromTo(
          cards,
          {
            x: (_i: number, card: HTMLElement) => toCenter(card, "x"),
            y: (_i: number, card: HTMLElement) => toCenter(card, "y"),
            rotate: (i: number) => tilt[i % tilt.length] ?? 0,
            scale: 0.92,
          },
          {
            x: 0,
            y: 0,
            rotate: 0,
            scale: 1,
            ease: "power2.inOut",
            stagger: 0.05,
            immediateRender: true,
            scrollTrigger: {
              trigger: root.current,
              start: () => `top ${navOffset()}`,
              end: "+=110%",
              pin: true,
              scrub: 0.6,
              invalidateOnRefresh: true,
            },
          },
        );
      });
    },
    { scope: root, dependencies: [reduce], revertOnUpdate: true },
  );

  return (
    <section
      ref={root}
      id="team"
      aria-labelledby="team-heading"
      data-surface="night"
      className="relative overflow-hidden bg-night py-16 text-paper sm:flex sm:min-h-[calc(100dvh-4.5rem)] sm:items-center md:py-12"
    >
      <Container>
        <div className="grid max-w-3xl gap-3">
          <Eyebrow tone="dark">Creators</Eyebrow>
          <h2 id="team-heading" className="font-display text-4xl leading-none font-black text-balance md:text-5xl">
            Four people, one weekend, a lot of hallways.
          </h2>
          <p className="text-lg text-sage">Built at Hack Western 13. Hover a card, or tap Flip, to see what each of us made.</p>
        </div>
        <ul data-part="deck" className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4 xl-text:lg:grid-cols-2">
          {TEAM.map((person, i) => (
            <Card key={person.name} person={person} index={i} />
          ))}
        </ul>
      </Container>
    </section>
  );
}
