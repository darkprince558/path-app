/** Placeholder until the landing page (DESIGN.md P0: landing hero) is built. */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4 py-12">
      <p className="font-display text-5xl font-black tracking-wide">Path</p>
      <p className="text-lg leading-relaxed">
        Scan a venue, share a link, and let guests find their way in 3D.
      </p>
      <p className="text-muted">
        Open a guest link at <span className="font-mono text-rust">/s/&lt;shareId&gt;</span> to view a shared scan.
      </p>
      <a className="action-button w-fit" href="/record">Record a hallway</a>
      <a className="font-bold underline" href="/spaces">Open 3D spaces and navigation</a>
    </main>
  );
}
