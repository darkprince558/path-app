import { Link } from "react-router";
import { LogoMark } from "./shared";

const SECTIONS = [
  { href: "#problem", label: "Why Path" },
  { href: "#tour", label: "Features" },
  { href: "#who", label: "Who it's for" },
  { href: "#team", label: "Team" },
];

/** Top bar on the landing page. Visitors don't need it to open a map: only map owners log in. */
export default function LandingNav() {
  return (
    <header data-surface="night" className="sticky top-0 z-40 bg-night/92 text-paper backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 sm:px-6 lg:pl-20">
        <Link to="/" className="flex items-center gap-2 font-display text-2xl font-black tracking-wide">
          <LogoMark className="size-7 text-paper" />
          Path
        </Link>
        <nav aria-label="Sections" className="ml-auto hidden items-center gap-6 md:flex">
          {SECTIONS.map((s) => (
            <a key={s.href} href={s.href} className="font-bold text-sage transition-colors hover:text-paper">
              {s.label}
            </a>
          ))}
        </nav>
        <Link
          to="/maps"
          className="ml-auto inline-flex min-h-11 items-center rounded-full px-5 font-bold text-paper ring-2 ring-paper/40 transition-colors hover:bg-paper/10 md:ml-2"
        >
          Log in
        </Link>
      </div>
    </header>
  );
}
