/*
 * Not 404 brand. The name is written "Not 404" in sentences and "not404" in the
 * logo, where the 0 is a coral "you are here" ring: the place you were looking for
 * isn't a 404 anymore. The favicon is the ring alone (public/favicon.svg).
 */

export const PRODUCT_NAME = "Not 404";
export const TAGLINE = "Never 404 in real life.";

/** The coral ring with a dot: the 0 in the logo, and the favicon. */
export function PinZero({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" fill="none" stroke="#F48057" strokeWidth="4.6" />
      <circle cx="12" cy="12" r="3.1" fill="#F48057" />
    </svg>
  );
}

/**
 * The "not404" wordmark. Size it with a text size class; color comes from the
 * text color (the ring stays coral). Screen readers hear "Not 404".
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex font-display leading-none font-black tracking-tight ${className}`}>
      <span aria-hidden="true" className="inline-flex items-baseline">
        not4
        <PinZero className="mx-[0.03em] inline-block size-[0.78em] self-center" />4
      </span>
      <span className="sr-only">{PRODUCT_NAME}</span>
    </span>
  );
}
