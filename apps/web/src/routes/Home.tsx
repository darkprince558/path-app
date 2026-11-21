import { Link } from "react-router";

/** Placeholder until the landing page (DESIGN.md P0: landing hero) is built. */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4 py-12">
      <p className="font-display text-5xl font-black tracking-wide">Path</p>
      <p className="text-lg leading-relaxed">
        Scan a building, a campus or a trail, and share it as a 3D map anyone can find their way through.
      </p>
      <p className="text-muted">
        Open a guest link at <span className="font-mono text-rust">/s/&lt;shareId&gt;</span> to view a shared scan.
      </p>
      <Link
        to="/upload"
        className="mt-2 inline-flex min-h-14 items-center justify-center self-start rounded-full bg-coral px-6 text-lg font-bold text-ink"
      >
        Share a scan
      </Link>
    </main>
  );
}
