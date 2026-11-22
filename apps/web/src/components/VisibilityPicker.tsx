import type { Visibility } from "../lib/scans";
import OptionCards, { type Option } from "./OptionCards";

const OPTIONS: (Option<Visibility> & { label: string; detail: string })[] = [
  { value: "public", label: "Public", detail: "Anyone can find it in Community and open it." },
  { value: "unlisted", label: "Unlisted", detail: "Only people with the link or QR code can open it." },
  { value: "private", label: "Private", detail: "Only you and the people you add can open it." },
];

export function visibilityLabel(value: Visibility): string {
  return OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function visibilityDetail(value: Visibility): string {
  return OPTIONS.find((o) => o.value === value)?.detail ?? "";
}

export default function VisibilityPicker({ lockedReason, ...props }: {
  name: string;
  value: Visibility;
  onChange: (value: Visibility) => void;
  disabled?: boolean;
  /**
   * When set, only Private (and whatever is already chosen) can be picked, and the reason is
   * shown. Used until a map has at least one labelled place.
   */
  lockedReason?: string | null;
}) {
  const options = lockedReason
    ? OPTIONS.map((option) => ({ ...option, disabled: option.value !== "private" && option.value !== props.value }))
    : OPTIONS;
  return (
    <div className="grid gap-2">
      {lockedReason ? (
        <p id={`${props.name}-locked`} className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-bold text-night ring-1 ring-amber-400">
          {lockedReason}
        </p>
      ) : null}
      <OptionCards {...props} options={options} />
    </div>
  );
}
