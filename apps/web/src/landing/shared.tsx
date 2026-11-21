import type { ReactNode } from "react";

/** Page width, centered. */
export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 ${className}`}>{children}</div>;
}

/**
 * The map a visitor's phone opens from the landing page's QR codes. Set
 * VITE_DEMO_SHARE_URL to a hosted guest link (…/s/<shareId>) for the booth.
 * Without it, the code opens Community on this site.
 */
export function demoUrl(): string {
  return import.meta.env.VITE_DEMO_SHARE_URL || `${window.location.origin}/community`;
}

export function isLocalhost(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

/** Logo mark: a dotted route bending into a "you are here" dot. */
export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 26 26" className={className} aria-hidden="true">
      <path
        d="M5 23 V9 a6 6 0 0 1 12 0 a6 6 0 0 1 -6 6 H9"
        fill="none"
        stroke="#F48057"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="0.1 5.2"
      />
      <circle cx="9" cy="15" r="2.6" fill="currentColor" />
    </svg>
  );
}
