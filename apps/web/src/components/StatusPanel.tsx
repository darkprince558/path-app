import type { ReactNode } from "react";

/** Full-screen loading indicator on the night background used by every 3D view. */
export function LoadingPanel({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-night px-4" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex gap-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-2.5 rounded-full bg-coral motion-safe:animate-pulse"
              style={{ animationDelay: `${i * 200}ms` }}
            />
          ))}
        </div>
        <p className="font-display text-xl font-extrabold tracking-wide text-paper">{label}</p>
        {detail ? <p className="font-mono text-sm text-sage">{detail}</p> : null}
      </div>
    </div>
  );
}

/** A cream card on night for states where the scan can't be shown. */
export function MessagePanel({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-night px-4" role="alert">
      <div className="w-full max-w-sm rounded-2xl bg-surface p-6 text-forest shadow-xl">
        <h1 className="font-display text-2xl leading-tight font-black">{title}</h1>
        <div className="mt-3 space-y-3 text-base leading-relaxed">{children}</div>
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-coral px-6 font-bold text-ink transition-transform active:scale-[0.98]"
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
