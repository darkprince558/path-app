import { SkipLink } from "../components/AppLayout";
import { TAGLINE, Wordmark } from "../components/Logo";
import AppTour from "../landing/AppTour";
import BackToTop from "../landing/BackToTop";
import Creators from "../landing/Creators";
import Hero from "../landing/Hero";
import Join from "../landing/Join";
import LandingNav from "../landing/LandingNav";
import Problem from "../landing/Problem";
import WhoUses from "../landing/WhoUses";

/** Landing page at /. Sections and motion follow apps/web/DESIGN.md. */
export default function Home() {
  return (
    <div className="relative min-h-dvh bg-paper">
      <SkipLink />
      <LandingNav />
      <main id="main" tabIndex={-1} className="overflow-x-clip focus:outline-none">
        <Hero />
        <Problem />
        <AppTour />
        <WhoUses />
        <Creators />
        <Join />
      </main>
      <BackToTop />
      <footer data-surface="night" className="bg-night pt-10 pb-24 text-sage">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-x-8 gap-y-4 px-4 sm:px-6">
          <div>
            <Wordmark className="text-3xl text-paper" />
            <p className="mt-2 text-paper">{TAGLINE}</p>
          </div>
          <p className="text-sm">
            not404.vodka, the one link that&apos;s never not found. Built at Hack Western 13.
          </p>
        </div>
      </footer>
    </div>
  );
}
