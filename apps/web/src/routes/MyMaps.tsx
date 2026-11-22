import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import ConfirmDialog from "../components/ConfirmDialog";
import MapCard, { MapCardSkeleton } from "../components/MapCard";
import { filterMaps, fromOwned, fromShared, MAP_FILTERS, type MapFilter, type MapSummary } from "../lib/maps";
import { deleteMap, fetchMyMaps, fetchSharedMaps, ListUnavailableError, UploadError } from "../lib/scans";

type State =
  | { phase: "loading" }
  | { phase: "ready"; maps: MapSummary[] }
  | { phase: "unavailable" }
  | { phase: "error"; message: string };

const GRID = "grid grid-cols-2 gap-3 xl-text:max-sm:grid-cols-1 sm:grid-cols-3 md:gap-5 xl:grid-cols-4";

export default function MyMaps() {
  const [filter, setFilter] = useState<MapFilter>("all");
  const [state, setState] = useState<State>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [toDelete, setToDelete] = useState<MapSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    document.title = "Your maps · Not 404";
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });
    Promise.all([fetchMyMaps(controller.signal), fetchSharedMaps(controller.signal)])
      .then(([mine, shared]) => setState({ phase: "ready", maps: [...mine.map(fromOwned), ...shared.map(fromShared)] }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ListUnavailableError) return setState({ phase: "unavailable" });
        setState({ phase: "error", message: error instanceof Error ? error.message : "Couldn't load your maps." });
      });
    return () => controller.abort();
  }, [attempt]);

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await deleteMap(toDelete.editId ?? toDelete.id);
      setState((current) =>
        current.phase === "ready" ? { ...current, maps: current.maps.filter((m) => m.id !== toDelete.id) } : current,
      );
      toast.success("Map deleted", { description: toDelete.name });
      setToDelete(null);
    } catch (error) {
      toast.error("Couldn't delete the map", {
        description: error instanceof UploadError ? error.message : undefined,
      });
    } finally {
      setDeleting(false);
    }
  }

  const maps = state.phase === "ready" ? filterMaps(state.maps, filter) : [];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-end justify-between gap-4">
        <h1 className="font-display text-4xl leading-none font-black">Your maps</h1>
        <Link
          to="/maps/new"
          className="hidden min-h-11 items-center gap-2 rounded-full bg-coral px-5 font-bold text-ink md:inline-flex"
        >
          <Plus className="size-5" aria-hidden />
          New map
        </Link>
      </div>

      <div
        role="group"
        aria-label="Filter maps"
        // A scrolling row clips anything outside its box, so the vertical padding leaves
        // room for the pills' outline and the 3px focus ring.
        className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 py-2 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0"
      >
        {MAP_FILTERS.map(({ value, label }) => {
          const active = value === filter;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(value)}
              className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-bold whitespace-nowrap transition-colors ${
                active ? "bg-forest text-paper" : "bg-surface text-forest ring-1 ring-forest/20 hover:ring-forest/50"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {state.phase === "loading" ? (
        <div role="status" className="mt-5">
          <span className="sr-only">Loading your maps…</span>
          <ul className={GRID}>
            {[0, 1, 2, 3].map((i) => (
              <li key={i}>
                <MapCardSkeleton />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state.phase === "error" || state.phase === "unavailable" ? (
        <div role="alert" className="mt-6 rounded-2xl bg-surface p-5 ring-1 ring-rust/30">
          <p className="font-bold">Couldn't load your maps</p>
          <p className="mt-1 text-muted">
            {state.phase === "unavailable"
              ? "This server can't list maps yet. Maps you upload still work by their link."
              : state.message}
          </p>
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
        <div className="mt-6 rounded-2xl bg-surface p-6 text-center ring-1 ring-forest/10">
          <p className="font-bold">No maps yet</p>
          <p className="mt-1 text-muted">Upload a scan of a building, campus or trail to make your first map.</p>
          <Link to="/maps/new" className="mt-4 inline-flex min-h-11 items-center rounded-full bg-coral px-5 font-bold text-ink">
            New map
          </Link>
        </div>
      ) : null}

      {state.phase === "ready" && state.maps.length > 0 ? (
        maps.length ? (
          <ul className={`mt-5 ${GRID}`}>
            {maps.map((map) => (
              <li key={map.id}>
                <MapCard map={map} showMenu origin={{ path: "/maps", label: "Your maps" }} onDelete={setToDelete} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-10 text-center text-muted">No maps match this filter.</p>
        )
      ) : null}

      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete “${toDelete?.name ?? ""}”?`}
        confirmLabel="Delete map"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setToDelete(null)}
      >
        <p>Anyone with the link or QR code won't be able to open it anymore.</p>
        <p className="font-bold">This can't be undone.</p>
      </ConfirmDialog>
    </div>
  );
}
