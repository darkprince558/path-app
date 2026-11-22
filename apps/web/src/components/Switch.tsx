import { useId, type ReactNode } from "react";

/**
 * An on/off switch (role="switch"). The whole row is the button, so it's a big tap
 * target, and the state is written out ("On"/"Off") as well as shown by the knob.
 */
export default function Switch({
  checked,
  onChange,
  label,
  detail,
  tone = "light",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  detail?: ReactNode;
  /** "light" for paper/surface backgrounds, "dark" for night (3D view). */
  tone?: "light" | "dark";
}) {
  const labelId = useId();
  const detailId = useId();
  const dark = tone === "dark";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={detail ? detailId : undefined}
      onClick={() => onChange(!checked)}
      className={`flex min-h-12 w-full items-center gap-4 rounded-xl px-4 py-3 text-left ${
        dark ? "bg-night/85 text-paper ring-1 ring-sage/40" : "bg-surface text-forest ring-1 ring-forest/15"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span id={labelId} className="block font-bold">
          {label}
        </span>
        {detail ? (
          <span id={detailId} className={`block text-sm ${dark ? "text-sage" : "text-muted"}`}>
            {detail}
          </span>
        ) : null}
      </span>
      <span className={`shrink-0 text-sm font-bold ${dark ? "text-sage" : "text-muted"}`} aria-hidden="true">
        {checked ? "On" : "Off"}
      </span>
      <span
        aria-hidden="true"
        className={`relative h-8 w-14 shrink-0 rounded-full transition-colors ${
          checked ? (dark ? "bg-sage" : "bg-forest") : dark ? "bg-paper/20" : "bg-forest/20"
        }`}
      >
        <span
          className={`absolute top-1 left-1 size-6 rounded-full shadow transition-transform ${
            checked ? "translate-x-6" : ""
          } ${dark ? (checked ? "bg-night" : "bg-paper") : "bg-surface"}`}
        />
      </span>
    </button>
  );
}
