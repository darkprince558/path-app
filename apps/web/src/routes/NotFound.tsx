import { useEffect } from "react";

export default function NotFound() {
  useEffect(() => {
    document.title = "404 · Not 404";
  }, []);
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4 py-12">
      <h1 className="font-display text-4xl font-black">Ironic, we know. This page is a 404.</h1>
      <p className="text-lg">
        The page you were after isn't here. Guest links look like <span className="font-mono text-rust">/s/&lt;shareId&gt;</span>.
      </p>
      <a href="/" className="font-bold text-rust underline underline-offset-4">
        Go to the home page
      </a>
    </main>
  );
}
