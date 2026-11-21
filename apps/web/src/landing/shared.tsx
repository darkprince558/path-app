import { QRCodeSVG } from "qrcode.react";
import type { ReactNode } from "react";
import { Link } from "react-router";

/** Page width, centered. */
export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 ${className}`}>{children}</div>;
}

/** Small mono label above a section heading. */
export function Eyebrow({ children, tone = "light" }: { children: ReactNode; tone?: "light" | "dark" }) {
  return (
    <p className={`font-mono text-sm tracking-[0.12em] uppercase ${tone === "dark" ? "text-sage" : "text-muted"}`}>
      {children}
    </p>
  );
}

const BUTTON = "inline-flex min-h-13 items-center justify-center gap-2 rounded-full px-6 text-lg font-bold";

export function PrimaryLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className={`${BUTTON} bg-coral text-ink transition-transform hover:-translate-y-0.5`}>
      {children}
    </Link>
  );
}

export function SecondaryLink({ to, children, tone = "light" }: { to: string; children: ReactNode; tone?: "light" | "dark" }) {
  return (
    <Link
      to={to}
      className={`${BUTTON} ring-2 transition-colors ${
        tone === "dark" ? "text-paper ring-paper/50 hover:bg-paper/10" : "text-forest ring-forest hover:bg-forest/8"
      }`}
    >
      {children}
    </Link>
  );
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

export function DemoQr({ size = 112, caption }: { size?: number; caption: ReactNode }) {
  const url = demoUrl();
  const localOnly = !import.meta.env.VITE_DEMO_SHARE_URL && isLocalhost();
  return (
    <figure className="flex items-center gap-4">
      <div className="shrink-0 rounded-xl bg-paper p-2.5 shadow-[0_0_0_1px_rgb(169_196_174/0.3)]">
        <QRCodeSVG value={url} size={size} bgColor="#F3EBD0" fgColor="#15221B" level="M" title="QR code for a sample map" />
      </div>
      <figcaption className="max-w-[16rem] text-base leading-snug">
        {caption}
        {localOnly && import.meta.env.DEV ? (
          <span className="mt-1 block font-mono text-xs text-sage">
            Dev: this code points at localhost. Set VITE_DEMO_SHARE_URL for phones.
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
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
