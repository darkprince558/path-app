import { ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import { useReducedMotion } from "../lib/preferences";

/**
 * Floating "Back to top" button. It appears once you've scrolled well past the hero
 * and takes you (and keyboard focus) back to the top of the page.
 */
export default function BackToTop() {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > window.innerHeight * 1.5);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      onClick={() => {
        window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
        document.getElementById("main")?.focus({ preventScroll: true });
      }}
      data-surface="night"
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      className={`fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 inline-flex min-h-12 items-center gap-2 rounded-full bg-night/85 px-5 font-bold text-paper shadow-[0_12px_30px_-10px_rgb(0_0_0/0.6)] ring-1 ring-sage/30 backdrop-blur-md transition-[opacity,translate] duration-300 hover:bg-night ${
        shown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-4 opacity-0"
      }`}
    >
      <ArrowUp className="size-5" aria-hidden />
      Back to top
    </button>
  );
}
