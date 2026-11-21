import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ArrowLeft, Settings as SettingsIcon } from "lucide-react";
import { LoadingPanel, MessagePanel } from "../components/StatusPanel";
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

type State =
  | { phase: "metadata" }
  | { phase: "asset"; meta: ShareMetadata }
  | { phase: "parsing"; meta: ShareMetadata; bytes: number }
  | { phase: "ready"; meta: ShareMetadata; scan: PointScan }
  | { phase: "not-found" }
  | { phase: "unsupported"; meta: ShareMetadata }
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

  useEffect(() => {
    document.title = "Shared scan · Path";
  }, []);

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
      if (meta.format !== "ply") return setState({ phase: "unsupported", meta });

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
          showHint={!touched}
          onReset={resetView}
          avoidStairs={avoidStairs}
          onAvoidStairsChange={setAvoidStairs}
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

      {state.phase === "unsupported" ? (
        <MessagePanel title="This scan can't be shown yet">
          <p>
            It was uploaded as <span className="font-mono">{state.meta.format.toUpperCase()}</span>. The guest view
            shows PLY point clouds for now.
          </p>
        </MessagePanel>
      ) : null}

      {state.phase === "parse-failed" ? (
        <MessagePanel title="We couldn't read this scan" action={{ label: "Try again", onClick: retry }}>
          <p>The file downloaded, but it isn't a point cloud the viewer understands.</p>
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
  showHint,
  onReset,
  avoidStairs,
  onAvoidStairsChange,
  children,
}: {
  showHint: boolean;
  onReset: () => void;
  avoidStairs: boolean;
  onAvoidStairsChange: (value: boolean) => void;
  /** The 3D map, placed between the top bar and the bottom controls in reading order. */
  children: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const origin = readMapOrigin(location.state);
  // Names come from the card the map was opened from. The API has no map names yet (#3).
  const mapName = origin?.mapName ?? "Shared map";
  // Going back through history keeps the previous page's filters and scroll position.
  // A map opened straight from a link or QR has no previous page in Path.
  const canGoBack = origin !== null && (window.history.state as { idx?: number } | null)?.idx !== 0;
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
              className="pointer-events-auto font-display text-2xl leading-none font-black tracking-wide text-paper"
            >
              Path
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
          showHint ? "opacity-100" : "opacity-0"
        }`}
        aria-hidden="true"
      >
        Drag to turn · pinch to zoom
      </p>

      <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-end justify-between gap-3 bg-gradient-to-t from-night/90 to-transparent px-4 pt-10 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <TripSwitch checked={avoidStairs} onChange={onAvoidStairsChange} />
        <button
          type="button"
          onClick={onReset}
          className="pointer-events-auto ml-auto min-h-11 shrink-0 rounded-full bg-night/80 px-4 text-sm font-bold text-paper ring-1 ring-sage/50 active:bg-forest"
        >
          Reset view
        </button>
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
