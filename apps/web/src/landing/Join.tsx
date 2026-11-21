import { MapPin } from "lucide-react";
import { Container, DemoQr, Eyebrow, PrimaryLink, SecondaryLink } from "./shared";

/** Join us: the trail ends at a pin beside the call to action and a big QR code. */
export default function Join() {
  return (
    <section id="join" aria-labelledby="join-heading" className="bg-paper py-28 md:py-40">
      <Container className="grid items-center gap-10 md:grid-cols-[auto_1fr_auto]">
        <span className="grid size-16 place-items-center rounded-full bg-coral text-ink shadow-lg max-md:hidden" aria-hidden="true">
          <MapPin className="size-8" />
        </span>
        <div className="grid gap-4">
          <Eyebrow>Join us</Eyebrow>
          <h2 id="join-heading" className="font-display text-5xl leading-none font-black text-balance">
            Map your first place.
          </h2>
          <p className="max-w-xl text-xl leading-relaxed text-muted">
            A hallway, a campus, a trail or this weekend's venue. Scan it once, and the next person never has to search.
          </p>
          <div className="flex flex-wrap gap-3">
            <PrimaryLink to="/maps/new">Start mapping</PrimaryLink>
            <SecondaryLink to="/community">Explore community maps</SecondaryLink>
          </div>
        </div>
        <div data-surface="night" className="rounded-3xl bg-night p-5 text-paper">
          <DemoQr
            size={140}
            caption={
              <>
                <strong className="block font-bold">On your phone</strong>
                <span className="text-sage">Open a sample map. No app, no account.</span>
              </>
            }
          />
        </div>
      </Container>
    </section>
  );
}
