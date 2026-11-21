import type { Visibility } from "../lib/scans";

const OPTIONS: { value: Visibility; label: string; detail: string }[] = [
  { value: "public", label: "Public", detail: "Anyone can find it in Explore and open it." },
  { value: "unlisted", label: "Unlisted", detail: "Only people with the link or QR code can open it." },
  { value: "private", label: "Private", detail: "Only you and the people you add can open it." },
];

export function visibilityLabel(value: Visibility): string {
  return OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function visibilityDetail(value: Visibility): string {
  return OPTIONS.find((o) => o.value === value)?.detail ?? "";
}

/** Three radio cards. Real radio inputs, so keyboard arrows and screen readers work. */
export default function VisibilityPicker({
  name,
  value,
  onChange,
  disabled,
}: {
  name: string;
  value: Visibility;
  onChange: (value: Visibility) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2">
      {OPTIONS.map((option) => {
        const checked = option.value === value;
        return (
          <label
            key={option.value}
            className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border-2 px-4 py-3 transition-colors has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-coral ${
              checked ? "border-forest bg-forest/8" : "border-forest/15 bg-surface hover:border-forest/40"
            } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="mt-1 size-5 shrink-0 accent-forest focus-visible:outline-none"
            />
            <span>
              <span className="block font-bold">{option.label}</span>
              <span className="block text-sm text-muted">{option.detail}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
