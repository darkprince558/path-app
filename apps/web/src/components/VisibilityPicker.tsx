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

export default function VisibilityPicker(props: {
  name: string;
  value: Visibility;
  onChange: (value: Visibility) => void;
  disabled?: boolean;
}) {
  return <OptionCards {...props} options={OPTIONS} />;
}
