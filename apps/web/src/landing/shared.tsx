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
