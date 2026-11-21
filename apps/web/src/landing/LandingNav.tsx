import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Wordmark } from "../components/Logo";

const SECTIONS = [
  { href: "#problem", label: "Why Not 404" },
  { href: "#tour", label: "How it works" },
  { href: "#who", label: "Who it's for" },
  { href: "#team", label: "Team" },
];

/**
 * Top bar. Clear over the hero so the sky runs up behind it, frosted once you scroll.
 * Visitors don't need it to open a map: only map owners log in.
 */
export default function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      data-surface="night"
      className={`sticky top-0 z-40 text-paper transition-colors duration-300 ${scrolled ? "bg-night/80 backdrop-blur-md" : "bg-transparent"}`}
    >
      <div className="mx-auto grid max-w-6xl grid-cols-[1fr_auto] items-center gap-4 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 sm:px-6 md:grid-cols-[1fr_auto_1fr]">
        <Link to="/" className="w-fit text-[1.7rem]">
          <Wordmark />
        </Link>
        <nav aria-label="Sections" className="hidden items-center gap-8 md:flex">
          {SECTIONS.map((s) => (
            <a key={s.href} href={s.href} className="text-paper/80 transition-colors hover:text-paper">
              {s.label}
            </a>
          ))}
        </nav>
        <Link
          to="/maps"
          className="inline-flex min-h-11 items-center justify-self-end rounded-full bg-paper/8 px-5 font-bold text-paper ring-1 ring-paper/20 transition-colors hover:bg-paper/15"
        >
          Log in
        </Link>
      </div>
    </header>
  );
}
