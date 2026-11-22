import type { ReactNode } from "react";

export interface Option<T extends string> {
  value: T;
  label: ReactNode;
  detail?: ReactNode;
}

/**
 * A group of large radio cards. Real radio inputs, so arrow keys move between options
 * and screen readers announce the group, the label and the detail text.
 */
export default function OptionCards<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled,
  columns = 1,
}: {
  name: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  columns?: 1 | 3;
}) {
  return (
    <div className={`grid gap-2 ${columns === 3 ? "sm:grid-cols-3" : ""}`}>
      {options.map((option) => {
        const checked = option.value === value;
        const detailId = option.detail ? `${name}-${option.value}-detail` : undefined;
        return (
          <label
            key={option.value}
            className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border-2 px-4 py-3 transition-colors has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-(--focus-ring) ${
              checked ? "border-forest bg-surface ring-2 ring-forest ring-inset" : "border-forest/15 bg-surface hover:border-forest/40"
            } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              disabled={disabled}
              aria-describedby={detailId}
              onChange={() => onChange(option.value)}
              className="mt-1 size-5 shrink-0 accent-forest focus-visible:outline-none"
            />
            <span>
              <span className="block font-bold">{option.label}</span>
              {option.detail ? (
                <span id={detailId} className="block text-sm text-muted">
                  {option.detail}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
