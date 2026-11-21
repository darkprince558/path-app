import { useEffect, useState } from "react";
import { Link } from "react-router";
import MapCard from "../components/MapCard";
import type { MapSummary } from "../lib/maps";

type State =
  | { phase: "loading" }
  | { phase: "ready"; maps: MapSummary[] }
  | { phase: "error"; message: string };

/** Reads GET /api/scans/public. Maps have no names on the API yet, so cards use the short ID. */
async function fetchPublicMaps(signal: AbortSignal): Promise<MapSummary[]> {
  const response = await fetch("/api/scans/public", { signal });
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  const body = (await response.json()) as { scans?: { shareId: string; sharePath: string }[] };
  return (body.scans ?? []).map((scan) => ({
    id: scan.shareId,
    name: `Untitled map ${scan.shareId.slice(0, 6)}`,
    visibility: "public",
    sharePath: scan.sharePath,
  }));
}

export default function Community() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    document.title = "Community · Path";
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });
    fetchPublicMaps(controller.signal)
      .then((maps) => setState({ phase: "ready", maps }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          phase: "error",
          message: error instanceof TypeError ? "Couldn't reach the Path server." : (error as Error).message,
        });
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="font-display text-4xl leading-none font-black">Community</h1>
      <p className="mt-3 text-lg text-muted">Public maps anyone can open, no account needed.</p>

      {state.phase === "loading" ? (
        <p role="status" className="mt-8 text-muted">
          Loading public maps…
        </p>
      ) : null}

      {state.phase === "error" ? (
        <div role="alert" className="mt-8 rounded-2xl bg-surface p-5 ring-1 ring-rust/30">
          <p className="font-bold">Couldn't load community maps</p>
          <p className="mt-1 text-muted">{state.message}</p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-4 min-h-11 rounded-full bg-coral px-5 font-bold text-ink"
          >
            Try again
          </button>
        </div>
      ) : null}

      {state.phase === "ready" && state.maps.length === 0 ? (
        <div className="mt-8 rounded-2xl bg-surface p-6 text-center ring-1 ring-forest/10">
          <p className="font-bold">No public maps yet</p>
          <p className="mt-1 text-muted">Upload a map and choose Public, and it shows up here for everyone.</p>
          <Link to="/maps/new" className="mt-4 inline-flex min-h-11 items-center rounded-full bg-coral px-5 font-bold text-ink">
            New map
          </Link>
        </div>
      ) : null}

      {state.phase === "ready" && state.maps.length > 0 ? (
        <ul className="mt-6 grid grid-cols-2 gap-3 xl-text:max-sm:grid-cols-1 sm:grid-cols-3 md:gap-5 xl:grid-cols-4">
          {state.maps.map((map) => (
            <li key={map.id}>
              <MapCard map={map} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
