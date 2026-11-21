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
      <div className="mt-2 flex flex-wrap gap-3">
        <Link
          to="/maps"
          className="inline-flex min-h-14 items-center justify-center rounded-full bg-coral px-6 text-lg font-bold text-ink"
        >
          Open my maps
        </Link>
        <Link
          to="/community"
          className="inline-flex min-h-14 items-center justify-center rounded-full px-6 text-lg font-bold text-forest ring-2 ring-forest"
        >
          Browse community maps
        </Link>
      </div>
    </main>
  );
}
