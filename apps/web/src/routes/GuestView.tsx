import { lazy, Suspense, useEffect, useState } from "react";
import { useParams } from "react-router";
import { LoadingPanel, MessagePanel } from "../components/StatusPanel";
import type { SpaceModel } from "../components/SpaceViewer";
import type { PointScan } from "../lib/ply";
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
        // Legacy share metadata has no space alignment. Production space views
        // pass the persisted scan-to-space matrix to the same renderer.
        setState({ phase: "ready-glb", meta, models: [{ id: meta.shareId, bytes: buffer, transform: IDENTITY }] });
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
    <main className="relative h-dvh w-full overflow-hidden bg-night text-paper" aria-label="Shared venue scan">
      {state.phase === "ready" ? (
        <>
          <div className="absolute inset-0 touch-none" onPointerDown={() => setTouched(true)}>
            <Suspense fallback={<LoadingPanel label="Building the 3D view…" />}>
              <ScanViewer scan={state.scan} resetToken={resetToken} />
            </Suspense>
          </div>
          <p className="sr-only">
            A 3D point cloud of the shared venue scan with {state.scan.count.toLocaleString()} points. Drag to look
            around, pinch or scroll to zoom.
          </p>
          <ViewerChrome
            shareId={state.meta.shareId}
            scan={state.scan}
            showHint={!touched}
            onReset={() => setResetToken((n) => n + 1)}
          />
        </>
      ) : null}

      {state.phase === "ready-glb" ? (
        <>
          <div className="absolute inset-0 touch-none" onPointerDown={() => setTouched(true)}>
            <Suspense fallback={<LoadingPanel label="Building the 3D view…" />}>
              <SpaceViewer models={state.models} nodes={[]} edges={[]} resetToken={resetToken}
                onError={(message) => setState({ phase: "parse-failed", meta: state.meta, message })} />
            </Suspense>
          </div>
          <p className="sr-only">A 3D model of the shared scan. Drag to look around, pinch or scroll to zoom.</p>
          <ViewerChrome shareId={state.meta.shareId} showHint={!touched} onReset={() => setResetToken((n) => n + 1)} />
        </>
      ) : null}

      {state.phase === "metadata" ? <LoadingPanel label="Opening the scan…" /> : null}
      {state.phase === "asset" ? <LoadingPanel label="Downloading the scan…" /> : null}
      {state.phase === "parsing" ? (
        <LoadingPanel label="Building the 3D view…" detail={formatBytes(state.bytes)} />
      ) : null}

      {state.phase === "not-found" ? (
        <MessagePanel title="This link isn't open to you" action={{ label: "Try again", onClick: retry }}>
          <p>The scan may have been removed or made private, or the link may be mistyped.</p>
          <p>Ask the organizer for a fresh link or QR code.</p>
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
  shareId,
  scan,
  showHint,
  onReset,
}: {
  shareId: string;
  scan?: PointScan;
  showHint: boolean;
  onReset: () => void;
}) {
  const downsampled = scan && scan.count < scan.sourceCount;
  return (
    <>
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-gradient-to-b from-night/90 to-transparent px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-8">
        <a
          href="/"
          className="pointer-events-auto font-display text-2xl leading-none font-black tracking-wide text-paper"
        >
          Path
        </a>
        <div className="text-right font-mono text-xs leading-relaxed text-sage">
          <div title={shareId}>scan {shareId.slice(0, 8)}</div>
          <div>
            {scan ? `${scan.count.toLocaleString()} pts${downsampled ? ` of ${scan.sourceCount.toLocaleString()}` : ""}` : "GLB model"}
          </div>
        </div>
      </header>

      <footer className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-night/90 to-transparent px-4 pt-10 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p
          className={`min-w-0 truncate rounded-full bg-night/80 px-3 py-2 text-sm whitespace-nowrap text-paper ring-1 ring-sage/30 transition-opacity duration-500 ${
            showHint ? "opacity-100" : "opacity-0"
          }`}
          aria-hidden={!showHint}
        >
          Drag to turn · pinch to zoom
        </p>
        <button
          type="button"
          onClick={onReset}
          className="pointer-events-auto min-h-11 shrink-0 rounded-full bg-night/80 px-4 text-sm font-bold text-paper ring-1 ring-sage/50 active:bg-forest"
        >
          Reset view
        </button>
      </footer>
    </>
  );
}
