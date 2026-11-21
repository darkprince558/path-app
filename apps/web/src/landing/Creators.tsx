import { ArrowUpRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import arielle from "../assets/team/arielle.jpg";
import sam from "../assets/team/sam.jpg";
import { useReducedMotion } from "../lib/preferences";
import { Container } from "./shared";

/*
 * Creators. The four cards start as one pile in the middle and fan out into a row
 * when the section scrolls into view (no scroll pinning). Each card turns over to
 * its links on hover with a mouse, on tap on a phone, and when keyboard focus
 * reaches it. Photos are cropped to the same framing (3:4, face about a quarter of
 * the way down) so everyone looks the same size.
 */

interface Link {
  label: "GitHub" | "LinkedIn" | "Résumé" | "Portfolio";
  /** Leave out until there's a real link; the button then shows "coming soon". */
  href?: string;
}

interface Person {
  name: string;
  role: string;
  photo?: string;
  initials: string;
  links: Link[];
}

const links = (github?: string, linkedin?: string, resume?: string, portfolio?: string): Link[] => [
  { label: "GitHub", href: github },
  { label: "LinkedIn", href: linkedin },
  { label: "Résumé", href: resume },
  { label: "Portfolio", href: portfolio },
];

const TEAM: Person[] = [
  { name: "Arielle", role: "Frontend, 3D viewer and UX", photo: arielle, initials: "AB", links: links("https://github.com/AryBaum") },
  { name: "Sam", role: "Backend and sharing", photo: sam, initials: "S", links: links() },
  { name: "Krishna", role: "Phone capture", initials: "K", links: links() },
  { name: "Anish", role: "Phone capture and testing", initials: "A", links: links() },
];

/** Contour lines, like a topographic map, for people without a photo yet. */
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
  return (
    <div className="flip-card relative aspect-[3/4] w-full" data-flipped={flipped}>
      <div className="flip-inner relative size-full">
        {/* Front: the photo. The whole front is the button that turns the card on a phone. */}
        <button
          type="button"
          onClick={() => setFlipped(true)}
          className="flip-face absolute inset-0 overflow-hidden rounded-3xl bg-forest text-left text-paper shadow-[0_24px_50px_-28px_rgb(0_0_0/0.9)] ring-1 ring-sage/25"
        >
          {person.photo ? (
            <img src={person.photo} alt="" className="absolute inset-0 size-full object-cover" loading="lazy" decoding="async" />
          ) : (
            <>
              <Contours seed={index + 1} />
              <span className="absolute inset-0 grid place-items-center pb-16 font-display text-7xl font-black tracking-tight" aria-hidden="true">
                {person.initials}
              </span>
            </>
          )}
          <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-night via-night/80 to-transparent px-5 pt-16 pb-5">
            <span className="block font-display text-2xl leading-none font-black">{person.name}</span>
            <span className="mt-1.5 block text-sage">{person.role}</span>
            <span className="sr-only"> Show links</span>
          </span>
        </button>

        {/* Back: the links. Clicking anywhere that isn't a link turns it back. */}
        <div
          className="flip-face flip-back absolute inset-0 grid content-center gap-3 rounded-3xl bg-[#1B2A21] p-5 text-paper ring-1 ring-sage/25"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a")) return;
            setFlipped(false);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setFlipped(false);
              (document.activeElement as HTMLElement | null)?.blur();
            }
          }}
        >
          <p className="font-display text-2xl leading-none font-black">{person.name}</p>
          <ul className="grid gap-2">
            {person.links.map((link) => (
              <li key={link.label}>
                {link.href ? (
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-h-11 items-center justify-between gap-2 rounded-xl bg-night px-4 font-bold ring-1 ring-sage/20 transition-colors hover:bg-coral hover:text-ink"
                  >
                    {link.label}
                    <ArrowUpRight className="size-4" aria-hidden />
                  </a>
                ) : (
                  <span className="flex min-h-11 items-center justify-between gap-2 rounded-xl px-4 font-bold text-sage ring-1 ring-sage/25 ring-inset">
                    {link.label}
                    <span className="text-sm font-normal">coming soon</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Tilt of each card while they're still one pile. */
const PILE_TILT = [-8, 5, -3, 7];

/**
 * The cards start as one pile in the middle of the row and fan out when the row
 * scrolls into view. Offsets come from each card's laid-out position (offsetLeft
 * and offsetTop ignore transforms), so the pile works for any column count.
 */
function useDeck(enabled: boolean) {
  const list = useRef<HTMLUListElement>(null);
  const [offsets, setOffsets] = useState<{ x: number; y: number }[]>([]);
  const [spread, setSpread] = useState(!enabled);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element || !enabled) return;
    const measure = () => {
      const cards = [...element.children] as HTMLElement[];
      setOffsets(
        cards.map((card) => ({
          x: element.clientWidth / 2 - (card.offsetLeft + card.offsetWidth / 2),
          y: element.clientHeight / 2 - (card.offsetTop + card.offsetHeight / 2),
        })),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setSpread(true);
      return;
    }
    setSpread(false);
    const element = list.current;
    if (!element) return;
    let timer = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          timer = window.setTimeout(() => setSpread(true), 250);
          observer.disconnect();
        }
      },
      { threshold: 0.45 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [enabled]);

  const styleFor = (i: number): CSSProperties => {
    const offset = offsets[i];
    if (!enabled || spread || !offset) {
      return { transitionDelay: enabled ? `${i * 90}ms` : undefined, zIndex: TEAM.length - i };
    }
    return {
      transform: `translate(${offset.x}px, ${offset.y}px) rotate(${PILE_TILT[i % PILE_TILT.length]}deg) scale(0.94)`,
      zIndex: TEAM.length - i,
    };
  };

  return { list, styleFor };
}

function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export default function Creators() {
  const reduce = useReducedMotion();
  // The pile needs cards side by side; on a phone (one column) they simply appear.
  const roomy = useMinWidth(640);
  const { list, styleFor } = useDeck(!reduce && roomy);

  return (
    <section id="team" aria-labelledby="team-heading" data-surface="night" className="relative bg-night py-28 text-paper md:py-40">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_40%_at_85%_0%,rgb(47_74_58/0.8),transparent_70%),radial-gradient(40%_30%_at_10%_100%,rgb(47_74_58/0.5),transparent_70%)]"
      />
      <Container className="relative">
        <div className="mx-auto grid max-w-2xl gap-3 text-center">
          <h2 id="team-heading" className="font-display text-[clamp(2rem,3.6vw,3rem)] leading-none font-black text-balance">
            Four people, one weekend, a lot of hallways.
          </h2>
          <p className="text-lg text-sage">Built at Hack Western 13. Hover or tap a card for links.</p>
        </div>
        <ul
          ref={list}
          className="relative mx-auto mt-16 grid max-w-xs gap-6 sm:max-w-2xl sm:grid-cols-2 lg:max-w-none lg:grid-cols-4 xl-text:lg:max-w-2xl xl-text:lg:grid-cols-2"
        >
          {TEAM.map((person, i) => (
            <li key={person.name} className="relative transition-transform duration-[900ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]" style={styleFor(i)}>
              <Card person={person} index={i} />
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
