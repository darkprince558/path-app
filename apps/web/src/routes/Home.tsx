import { SkipLink } from "../components/AppLayout";
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
      <footer data-surface="night" className="bg-night py-8 text-sage">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:pl-20">Path · Built at Hack Western 13</div>
      </footer>
    </div>
  );
}
