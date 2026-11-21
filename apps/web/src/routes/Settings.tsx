import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import OptionCards from "../components/OptionCards";
import Switch from "../components/Switch";
import { usePreferences, type MotionPreference, type TextSize } from "../lib/preferences";

const TEXT_SIZES: { value: TextSize; label: string; sample: string }[] = [
  { value: "default", label: "Default", sample: "text-base" },
  { value: "large", label: "Large", sample: "text-lg" },
  { value: "xlarge", label: "Extra large", sample: "text-xl" },
];

const MOTION: { value: MotionPreference; label: string; detail: string }[] = [
  { value: "system", label: "Match my device", detail: "Follows the Reduce Motion setting on your phone or computer." },
  { value: "reduce", label: "Reduce motion", detail: "Turns off animations and the smooth glide when you let go of the 3D map." },
  { value: "full", label: "Allow motion", detail: "Keeps animations on, even if your device asks to reduce them." },
];

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <div>
        <h2 id={id} className="font-display text-2xl font-extrabold">
          {title}
        </h2>
        {intro ? <p className="mt-1 text-muted">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

export default function Settings() {
  const { preferences, update } = usePreferences();
  const location = useLocation();
  const backTo = (location.state as { from?: string } | null)?.from;

  useEffect(() => {
    document.title = "Settings · Path";
  }, []);

  return (
    <div className="mx-auto grid max-w-xl gap-10">
      <div>
        {backTo ? (
          <Link to={backTo} className="text-sm font-bold text-rust underline underline-offset-4">
            ← Back to the map
          </Link>
        ) : null}
        <h1 className={`font-display text-4xl leading-none font-black ${backTo ? "mt-4" : ""}`}>Settings</h1>
        <p className="mt-3 text-lg text-muted">Saved on this device. They apply to every map you open here.</p>
      </div>

      <Section id="text-size" title="Text size" intro="Makes all text and buttons bigger, including on maps.">
        <OptionCards
          name="text-size"
          value={preferences.textSize}
          onChange={(textSize) => update({ textSize })}
          columns={3}
          options={TEXT_SIZES.map(({ value, label, sample }) => ({
            value,
            label: (
              <span className="flex items-baseline gap-2">
                <span aria-hidden="true" className={`font-display font-black ${sample}`}>
                  Aa
                </span>
                {label}
              </span>
            ),
          }))}
        />
      </Section>

      <Section id="motion" title="Motion">
        <OptionCards name="motion" value={preferences.motion} onChange={(motion) => update({ motion })} options={MOTION} />
      </Section>

      <Section
        id="getting-around"
        title="Getting around"
        intro="Your default for every trip. You can still change it on the map for one trip, for example when you're with a friend who can't take stairs."
      >
        <Switch
          checked={preferences.avoidStairs}
          onChange={(avoidStairs) => update({ avoidStairs })}
          label="Avoid stairs"
          detail="Routes use elevators and ramps instead."
        />
      </Section>
    </div>
  );
}
