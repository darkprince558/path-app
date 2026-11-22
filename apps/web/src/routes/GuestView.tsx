import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { singleScanNavigation } from "../lib/automatic-navigation";
import { Wordmark } from "../components/Logo";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ArrowLeft, MapPin, Milestone, Settings as SettingsIcon, X } from "lucide-react";
import { LoadingPanel, MessagePanel } from "../components/StatusPanel";
import type { SpaceModel } from "../components/SpaceViewer";
import { fetchShareCues, type Cue } from "../lib/cues";
import { CATEGORY_LABEL, fetchPlaces, type Place } from "../lib/places";
import { readMapOrigin } from "../lib/maps";
import { useReducedMotion, useTripAvoidStairs } from "../lib/preferences";
import type { PointScan } from "../lib/ply";
import { formatBytes } from "../lib/scans";
import { fetchAsset, fetchShare, ShareError, type ShareMetadata } from "../lib/shares";

// three.js, drei and the PLY parser live in a separate chunk. Both imports start
// when the guest route mounts, so the code downloads while the share metadata loads.
const loadViewer = () => import("../components/ScanViewer");
const loadParser = () => import("../lib/ply");
const ScanViewer = lazy(loadViewer);
const loadSpaceViewer = () => import("../components/SpaceViewer");
const SpaceViewer = lazy(loadSpaceViewer);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

type State =
  | { phase: "metadata" }
  | { phase: "asset"; meta: ShareMetadata }
  | { phase: "parsing"; meta: ShareMetadata; bytes: number }
  | { phase: "ready"; meta: ShareMetadata; scan: PointScan }
  | { phase: "ready-glb"; meta: ShareMetadata; models: SpaceModel[] }
  | { phase: "not-found" }
  | { phase: "parse-failed"; meta: ShareMetadata; message: string }
  | { phase: "error"; step: "metadata" | "asset"; message: string };

/**
 * Yields so the "building" message can paint before a large parse blocks the thread.
 * requestAnimationFrame never fires in a background tab, so a timeout backs it up.
 */
const yieldToPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
    setTimeout(resolve, 50);
  });

export default function GuestView() {
  const { shareId = "" } = useParams();
  const [state, setState] = useState<State>({ phase: "metadata" });
  const [attempt, setAttempt] = useState(0);
  const [resetToken, setResetToken] = useState(0);
  const [touched, setTouched] = useState(false);
  const reduceMotion = useReducedMotion();
  const [avoidStairs, setAvoidStairs] = useTripAvoidStairs(shareId);
  const resetView = useCallback(() => setResetToken((n) => n + 1), []);
  // Approved landmark directions load alongside the map; without any, nothing extra shows.
  const [cues, setCues] = useState<Cue[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setCues([]);
    void fetchShareCues(shareId, controller.signal).then((list) => {
      if (!controller.signal.aborted) setCues(list);
    });
    setPlaces([]);
    void fetchPlaces(shareId, controller.signal).then((list) => {
      if (!controller.signal.aborted) setPlaces(list);
    }).catch(() => {});
    return () => controller.abort();
  }, [shareId]);

  useEffect(() => {
    const ready = state.phase === "ready" || state.phase === "ready-glb";
    document.title = ready && state.meta.name ? `${state.meta.name} · Not 404` : "Shared map · Not 404";
  }, [state]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let geometry: PointScan["geometry"] | undefined;
    setState({ phase: "metadata" });
    const parser = loadParser();
    void loadViewer();

    (async () => {
      let meta: ShareMetadata;
      try {
        meta = await fetchShare(shareId, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ShareError && error.kind === "not-found") return setState({ phase: "not-found" });
        return setState({ phase: "error", step: "metadata", message: (error as Error).message });
      }
      if (meta.format === "glb") void loadSpaceViewer();

      setState({ phase: "asset", meta });
      let buffer: ArrayBuffer;
      try {
        buffer = await fetchAsset(meta.assetPath, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ShareError && error.kind === "not-found") return setState({ phase: "not-found" });
        return setState({ phase: "error", step: "asset", message: (error as Error).message });
      }

      setState({ phase: "parsing", meta, bytes: buffer.byteLength });
      await yieldToPaint();
      if (signal.aborted) return;
      if (meta.format === "glb") {
        // Older mock shares omit alignment; approved backend shares preserve it.
        setState({ phase: "ready-glb", meta, models: [{ id: meta.scanId ?? meta.shareId,
          name: meta.name, bytes: buffer, transform: meta.transform ?? IDENTITY }] });
        return;
      }
      try {
        const { parsePointCloud } = await parser;
        if (signal.aborted) return;
        const scan = parsePointCloud(buffer);
        geometry = scan.geometry;
        if (signal.aborted) return scan.geometry.dispose();
        setState({ phase: "ready", meta, scan });
      } catch (error) {
        const { ScanParseError } = await parser.catch(() => ({ ScanParseError: undefined }));
        if (signal.aborted) return;
        const message =
          ScanParseError && error instanceof ScanParseError ? error.message : "Unexpected error while reading the scan.";
        setState({ phase: "parse-failed", meta, message });
      }
    })();

    return () => {
      controller.abort();
      geometry?.dispose();
    };
  }, [shareId, attempt]);

  const retry = () => setAttempt((n) => n + 1);

  return (
    <main data-surface="night" className="relative h-dvh w-full overflow-hidden bg-night text-paper" aria-label="Shared 3D map">
      {state.phase === "ready" ? (
        // Reading and Tab order: top bar, then the map, then the trip switch and Reset.
        <ViewerChrome
          name={state.meta.name}
          showHint={!touched}
          onReset={resetView}
          avoidStairs={avoidStairs}
          onAvoidStairsChange={setAvoidStairs}
          cues={cues}
        >
          <div
            className="absolute inset-0 touch-none"
            onPointerDown={() => setTouched(true)}
            onKeyDown={() => setTouched(true)}
          >
            <Suspense fallback={<LoadingPanel label="Building the 3D view…" />}>
              <ScanViewer
                scan={state.scan}
                resetToken={resetToken}
                reduceMotion={reduceMotion}
                onReset={resetView}
              />
            </Suspense>
          </div>
          <p className="sr-only">
            A 3D map made from a scan of the place, with {state.scan.count.toLocaleString()} points. Drag to look
            around and pinch or scroll to zoom. With a keyboard, focus the map, then use the arrow keys to turn it,
            plus and minus to zoom, and R to reset.
          </p>
        </ViewerChrome>
      ) : null}

      {state.phase === "ready-glb" ? (
        // A textured or meshed scan (GLB), drawn by the space viewer with the scan's saved transform.
        <ViewerChrome
          name={state.meta.name}
          showHint={!touched}
          onReset={resetView}
          avoidStairs={avoidStairs}
          onAvoidStairsChange={setAvoidStairs}
          cues={cues}
          places={places}
          selectedPlace={selectedPlace}
          onSelectPlace={setSelectedPlace}
        >
          <div className="absolute inset-0 touch-none" onPointerDown={() => setTouched(true)}>
            <Suspense fallback={<LoadingPanel label="Building the 3D view…" />}>
              <SpaceViewer
                places={places.map((place) => ({ id: place.id, name: place.name, categoryLabel: CATEGORY_LABEL[place.category], local: place.position }))}
                highlightPlaceId={selectedPlace}
                onPlaceSelect={setSelectedPlace}
                key={shareId}
                automaticNavigation
                initialAutomaticNavigation
                navigationUnavailable={singleScanNavigation(state.meta.metadata).unavailable}
                navigationApproximate={singleScanNavigation(state.meta.metadata).approximate}
                avoidStairs={avoidStairs}
                models={state.models}
                nodes={[]}
                edges={[]}
                resetToken={resetToken}
                onError={(message) => setState({ phase: "parse-failed", meta: state.meta, message })}
              />
            </Suspense>
          </div>
          <p className="sr-only">A 3D model made from a scan of the place. Drag to look around and pinch or scroll to zoom.</p>
        </ViewerChrome>
      ) : null}

      {state.phase === "metadata" ? <LoadingPanel label="Opening the scan…" /> : null}
      {state.phase === "asset" ? <LoadingPanel label="Downloading the scan…" /> : null}
      {state.phase === "parsing" ? (
        <LoadingPanel label="Building the 3D view…" detail={formatBytes(state.bytes)} />
      ) : null}

      {state.phase === "not-found" ? (
        <MessagePanel title="This link isn't open to you" action={{ label: "Try again", onClick: retry }}>
          <p>The scan may have been removed or made private, or the link may be mistyped.</p>
          <p>Ask the person who shared it for a fresh link or QR code.</p>
        </MessagePanel>
      ) : null}

      {state.phase === "parse-failed" ? (
        <MessagePanel title="We couldn't read this scan" action={{ label: "Try again", onClick: retry }}>
          <p>The file downloaded, but the viewer could not read its {state.meta.format === "glb" ? "3D model" : "point cloud"}.</p>
          <p className="rounded-lg bg-paper px-3 py-2 font-mono text-sm break-words text-muted">{state.message}</p>
        </MessagePanel>
      ) : null}

      {state.phase === "error" ? (
        <MessagePanel
          title={state.step === "metadata" ? "Couldn't open this link" : "The scan didn't download"}
          action={{ label: "Try again", onClick: retry }}
        >
          <p>Check your connection and try again.</p>
          <p className="font-mono text-sm text-muted">{state.message}</p>
        </MessagePanel>
      ) : null}
    </main>
  );
}

function ViewerChrome({
  name,
  showHint,
  onReset,
  avoidStairs,
  onAvoidStairsChange,
  cues,
  places = [],
  selectedPlace = null,
  onSelectPlace,
  children,
}: {
  /** Map name from the API, if it sent one. */
  name?: string;
  showHint: boolean;
  onReset: () => void;
  avoidStairs: boolean;
  onAvoidStairsChange: (value: boolean) => void;
  /** Approved landmark directions for this map, if any. */
  cues: Cue[];
  /** Named places the owner pinned on the map. */
  places?: Place[];
  selectedPlace?: string | null;
  onSelectPlace?: (id: string) => void;
  /** The 3D map, placed between the top bar and the bottom controls in reading order. */
  children: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const origin = readMapOrigin(location.state);
  // The API's name wins. Older servers send none, so fall back to the card's name.
  const mapName = name ?? origin?.mapName ?? "Shared map";
  // Going back through history keeps the previous page's filters and scroll position.
  // A map opened straight from a link or QR has no previous page in Not 404.
  const canGoBack = origin !== null && (window.history.state as { idx?: number } | null)?.idx !== 0;
  const [directionsOpen, setDirectionsOpen] = useState(false);
  const [placesOpen, setPlacesOpen] = useState(false);
  return (
    <>
      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 bg-gradient-to-b from-night/90 to-transparent px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-8">
        <div className="min-w-0">
          {origin ? (
            <Link
              to={origin.from}
              onClick={(event) => {
                if (canGoBack) {
                  event.preventDefault();
                  navigate(-1);
                }
              }}
              className="pointer-events-auto inline-flex min-h-11 items-center gap-1.5 rounded-full bg-night/80 pr-4 pl-2.5 text-sm font-bold text-paper ring-1 ring-sage/50"
            >
              <ArrowLeft className="size-5" aria-hidden />
              {origin.fromLabel}
            </Link>
          ) : (
            <Link
              to="/"
              className="pointer-events-auto text-2xl text-paper"
            >
              <Wordmark />
            </Link>
          )}
          <h1 className="mt-2 truncate font-display text-xl leading-tight font-black text-paper">{mapName}</h1>
        </div>
        <Link
          to="/settings"
          state={{ from: location.pathname, origin }}
          aria-label="Settings: text size, motion, avoid stairs"
          className="pointer-events-auto -mt-1 -mr-1 grid size-11 place-items-center rounded-full bg-night/80 text-paper ring-1 ring-sage/50"
        >
          <SettingsIcon className="size-5" aria-hidden />
        </Link>
      </header>

      {children}

      <p
        className={`pointer-events-none absolute inset-x-0 bottom-24 z-10 mx-auto xl-text:bottom-40 w-fit max-w-[calc(100%-2rem)] truncate rounded-full bg-night/80 px-3 py-2 text-sm text-paper ring-1 ring-sage/30 transition-opacity duration-500 ${
          showHint && !directionsOpen ? "opacity-100" : "opacity-0"
        }`}
        aria-hidden="true"
      >
        Drag to turn · pinch to zoom
      </p>

      {/* Controls first in reading order; flex-col-reverse draws the open Directions panel above them,
          however many rows the controls wrap to. */}
      <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col-reverse gap-3 bg-gradient-to-t from-night/90 to-transparent px-4 pt-10 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <TripSwitch checked={avoidStairs} onChange={onAvoidStairsChange} />
          {cues.length ? (
            <button
              type="button"
              aria-expanded={directionsOpen}
              aria-controls="map-directions"
              onClick={() => { setDirectionsOpen((open) => !open); setPlacesOpen(false); }}
              className={`pointer-events-auto flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-bold ring-1 ${
                directionsOpen ? "bg-sage text-ink ring-sage" : "bg-night/80 text-paper ring-sage/50"
              }`}
            >
              <Milestone className="size-5" aria-hidden />
              Directions · {cues.length}
            </button>
          ) : null}
          {places.length ? (
            <button
              type="button"
              aria-expanded={placesOpen}
              aria-controls="map-places"
              onClick={() => { setPlacesOpen((open) => !open); setDirectionsOpen(false); }}
              className={`pointer-events-auto flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-bold ring-1 ${
                placesOpen ? "bg-sage text-ink ring-sage" : "bg-night/80 text-paper ring-sage/50"
              }`}
            >
              <MapPin className="size-5" aria-hidden />
              Places · {places.length}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onReset}
            className="pointer-events-auto ml-auto min-h-11 shrink-0 rounded-full bg-night/80 px-4 text-sm font-bold text-paper ring-1 ring-sage/50 active:bg-forest"
          >
            Reset view
          </button>
        </div>

        {places.length && placesOpen ? (
          <section
            id="map-places"
            aria-labelledby="map-places-title"
            className="pointer-events-auto mx-auto max-h-[40dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-night/95 p-4 text-paper ring-1 ring-sage/40"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 id="map-places-title" className="font-display text-lg font-black">
                Places
              </h2>
              <button
                type="button"
                onClick={() => setPlacesOpen(false)}
                aria-label="Hide places"
                className="-mt-1 -mr-1 grid size-11 shrink-0 place-items-center rounded-full text-paper ring-1 ring-sage/40"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <p className="mt-1 text-sm text-sage">Tap a label on the map to choose it as your start or destination.</p>
            <ul className="mt-2 grid gap-2">
              {places.map((place) => (
                <li key={place.id}>
                  <button
                    type="button"
                    aria-pressed={selectedPlace === place.id}
                    onClick={() => onSelectPlace?.(place.id)}
                    className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left ring-1 ${
                      selectedPlace === place.id ? "bg-amber-300 text-night ring-amber-500" : "ring-sage/30"
                    }`}
                  >
                    <MapPin className="size-5 shrink-0" aria-hidden />
                    <span className="text-lg leading-snug">{place.name}</span>
                    <span className="ml-auto text-sm opacity-80">{CATEGORY_LABEL[place.category]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {cues.length && directionsOpen ? (
          <section
            id="map-directions"
            aria-labelledby="map-directions-title"
            className="pointer-events-auto mx-auto max-h-[40dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-night/95 p-4 text-paper ring-1 ring-sage/40"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 id="map-directions-title" className="font-display text-lg font-black">
                Directions
              </h2>
              <button
                type="button"
                onClick={() => setDirectionsOpen(false)}
                aria-label="Hide directions"
                className="-mt-1 -mr-1 grid size-11 shrink-0 place-items-center rounded-full text-paper ring-1 ring-sage/40"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <ol className="mt-2 grid gap-3">
              {cues.map((cue) => (
                <li key={cue.id} className="flex gap-3">
                  <span aria-hidden="true" className="mt-2 size-2.5 shrink-0 rounded-full bg-coral" />
                  <div>
                    <p className="text-lg leading-snug">{cue.instruction}</p>
                    <p className="text-sm text-sage">Approved by the map owner</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </footer>
    </>
  );
}

/**
 * "Avoid stairs" for this trip only. It starts from the default in Settings, and changing
 * it here doesn't change that default. The label doesn't say why, so nobody has to explain.
 */
function TripSwitch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby="trip-switch-detail"
      onClick={() => onChange(!checked)}
      className={`pointer-events-auto flex min-h-11 items-center gap-2.5 rounded-full py-1.5 pr-4 pl-1.5 text-sm font-bold whitespace-nowrap ring-1 ${
        checked ? "bg-sage text-ink ring-sage" : "bg-night/80 text-paper ring-sage/50"
      }`}
    >
      <span
        aria-hidden="true"
        className={`relative h-7 w-12 shrink-0 rounded-full ${checked ? "bg-forest" : "bg-paper/20"}`}
      >
        <span
          className={`absolute top-1 left-1 size-5 rounded-full transition-transform ${
            checked ? "translate-x-5 bg-sage" : "bg-paper"
          }`}
        />
      </span>
      Avoid stairs
      <span id="trip-switch-detail" className="sr-only">
        For this trip only. Routes use elevators and ramps. Your default is in Settings.
      </span>
    </button>
  );
}
