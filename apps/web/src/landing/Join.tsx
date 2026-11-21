import { ArrowRight } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Link } from "react-router";
import { useReducedMotion } from "../lib/preferences";
import { WalkingPrints } from "./Footprint";
import { Container, demoUrl } from "./shared";

/*
 * Join us: the last stop. Footprints keep walking across the page on a loop, above
 * one clear call to action, with the sample-map QR code beside it on laptops
 * (phones are already where the code would take them).
 */

export default function Join() {
  const reduce = useReducedMotion();
  return (
    <section id="join" aria-labelledby="join-heading" className="relative overflow-hidden bg-paper py-28 md:py-40">
      <WalkingPrints reduce={reduce} className="block h-28 w-full" />

      <Container className="mt-10 grid items-center justify-items-center gap-12 md:mt-14 lg:grid-cols-[1fr_auto] lg:justify-items-start xl-text:lg:grid-cols-1">
        <div className="grid justify-items-center gap-5 text-center lg:justify-items-start lg:text-left">
          <h2 id="join-heading" className="font-display text-[clamp(2.5rem,5vw,4rem)] leading-none font-black text-balance">
            Map your first place.
          </h2>
          <p className="max-w-lg text-lg leading-relaxed text-muted">
            A hallway, a campus, a trail or this weekend&apos;s venue. Scan it once, and the next person never has to search.
          </p>
          <div className="flex flex-col items-center gap-x-5 gap-y-1 sm:flex-row">
            <Link
              to="/maps/new"
              className="inline-flex min-h-12 items-center justify-center rounded-full bg-coral px-6 font-bold text-ink shadow-[0_10px_30px_-12px_rgb(244_128_87/0.7)] transition-transform hover:-translate-y-0.5"
            >
              Start mapping
            </Link>
            <Link to="/community" className="inline-flex min-h-11 items-center gap-1.5 font-bold text-forest underline-offset-4 hover:underline">
              Explore community maps <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        </div>

        <figure
          data-surface="night"
          className="hidden items-center gap-5 rounded-3xl bg-night p-5 text-paper shadow-[0_30px_60px_-35px_rgb(18_28_22/0.9)] md:flex"
        >
          <div className="rounded-xl bg-paper p-2">
            <QRCodeSVG value={demoUrl()} size={128} bgColor="#F3EBD0" fgColor="#15221B" level="M" title="QR code for a sample map" />
          </div>
          <figcaption className="max-w-[11rem] leading-snug">
            <span className="block font-display text-xl font-black">Try it on your phone</span>
            <span className="mt-1 block text-sage">Scan to open a sample map. No app, no account.</span>
          </figcaption>
        </figure>
      </Container>
    </section>
  );
}
