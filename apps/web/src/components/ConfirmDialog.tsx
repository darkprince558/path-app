import { useEffect, useRef, type ReactNode } from "react";

/**
 * A modal "Are you sure?" built on <dialog>, which traps focus, closes on Escape and
 * returns focus to whatever opened it. The safe choice (Cancel) gets focus first.
 */
export default function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      data-surface="light"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[min(100%-2rem,26rem)] rounded-2xl bg-surface p-6 text-forest shadow-2xl backdrop:bg-night/60"
    >
      <h2 id="confirm-title" className="font-display text-2xl leading-tight font-black">
        {title}
      </h2>
      <div className="mt-3 space-y-2 leading-relaxed">{children}</div>
      <div className="mt-6 grid grid-cols-2 gap-3">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="min-h-12 rounded-full font-bold text-forest ring-2 ring-forest"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="min-h-12 rounded-full bg-rust px-4 font-bold text-paper disabled:opacity-70"
        >
          {busy ? "Deleting…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
