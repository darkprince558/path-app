import { AccountControls, useAuth } from "../lib/auth";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { automaticNavigationIssue } from "../lib/automatic-navigation";
import NavigationPanel from "../components/NavigationPanel";
import SpaceEditor, { type PickedPoint } from "../components/SpaceEditor";
import { LoadingPanel } from "../components/StatusPanel";
import { validateGraph, type Route } from "../lib/navigation";
import { coordinates, request, scanAligned, scanBytes, type Graph, type SavedPath, type Scan, type Space } from "../lib/space-api";

const SpaceViewer = lazy(() => import("../components/SpaceViewer"));
type Data = { space: Space; scans: Scan[]; graph: Graph; paths: SavedPath[] };
type Model = { id: string; name: string; bytes: ArrayBuffer; transform: number[] };

export default function SpaceView() {
  const { spaceId = "" } = useParams();
  const { user } = useAuth();
  const [search] = useSearchParams();
  const [data, setData] = useState<Data | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState("");
  const [assetError, setAssetError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [assetAttempt, setAssetAttempt] = useState(0);
  const [route, setRoute] = useState<Route | null>(null);
  const [automatic, setAutomatic] = useState(false);
  const [showGraph, setShowGraph] = useState(true);
  const [resetToken, setResetToken] = useState(0);
  const [picked, setPicked] = useState<PickedPoint | null>(null);
  const [shareMessage, setShareMessage] = useState("");
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  const onRoute = useCallback((next: Route | null) => setRoute(next), []);
  useEffect(() => { setData(null); setModels([]); setRoute(null); setPicked(null); }, [spaceId]);
  useEffect(() => {
    const controller = new AbortController(); const options = { signal: controller.signal };
    setError("");
    Promise.all([
      request<{ space: Space }>(`/api/spaces/${encodeURIComponent(spaceId)}`, options),
      request<{ scans: Scan[] }>(`/api/spaces/${encodeURIComponent(spaceId)}/scans`, options),
      request<Graph>(`/api/spaces/${encodeURIComponent(spaceId)}/graph`, options),
      request<{ paths: SavedPath[] }>("/api/paths", options),
    ]).then(([s, scans, graph, paths]) => {
      if (controller.signal.aborted) return;
      if (graph.spaceId !== spaceId || scans.scans.some(scan => scan.spaceId !== spaceId)) throw new Error("The response contains data for another space.");
      validateGraph(graph);
      setData({ space: s.space, scans: scans.scans, graph, paths: paths.paths.filter(p => p.spaceId === spaceId) });
      document.title = `${s.space.name} · !404`;
    }).catch(e => { if (!controller.signal.aborted) { setError(e.message); setData(null); setModels([]); } });
    return () => controller.abort();
  }, [spaceId, revision]);
  // Graph edits do not download and parse the same large scans again.
  const readyScansKey = JSON.stringify(data?.scans.filter(s => s.status === "ready" && s.format === "glb" && s.downloadPath).map(s => ({ id: s.id, spaceId: s.spaceId, name: s.name, transform: s.transform, metadata: s.metadata, downloadPath: s.downloadPath })) ?? []);
  const readyScans = useMemo(() => JSON.parse(readyScansKey) as Scan[], [readyScansKey]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setAssetError(""); setModels([]); setPicked(null);
    Promise.all(readyScans.map(async scan => ({ id: scan.id, name: scan.name, transform: scan.transform, bytes: await scanBytes(scan, controller.signal) })))
      .then(next => { if (!controller.signal.aborted) { setModels(next); if (!next.length) setLoading(false); } })
      .catch(e => { if (!controller.signal.aborted) { setAssetError(e.message); setLoading(false); } });
    return () => controller.abort();
  }, [readyScans, assetAttempt]);
  const owner = !!data && !!user && user.id === data.space.ownerId;
  const frame = data ? coordinates(data.space) : null;
  const alignmentWarning = data?.scans.some(s => s.status === "ready" && s.format === "glb" && !scanAligned(s, data.space)) ?? false;
  const navigationUnavailable = alignmentWarning || frame?.units !== "metres" ? "Automatic routing requires every visible scan aligned in calibrated metres." : readyScans.map(s => automaticNavigationIssue(s.metadata)).find(Boolean);
  return <main className="flex h-dvh flex-col bg-night md:flex-row" aria-label="3D space navigation">
    <aside className="z-10 max-h-[46dvh] shrink-0 space-y-4 overflow-y-auto bg-paper p-4 text-forest md:max-h-none md:w-80">
      <header className="flex items-center justify-between"><Link className="font-display text-2xl font-black" to="/spaces">!404</Link><button className="underline" onClick={() => { refresh(); setAssetAttempt(n => n + 1); }}>Refresh</button></header>
      <AccountControls />
      {error && <p role="alert">This space is unavailable or private. {error}</p>}
      {!data && !error && <p role="status">Opening space…</p>}
      {data && <>
        <h1 className="text-xl font-bold">{data.space.name}</h1>
        <p className="text-sm text-muted">{frame?.units === "metres" ? "Space coordinates in metres; verify each scan's calibration." : "Relative scale — physical distances have not been established."}</p>
        {alignmentWarning ? <p role="status" className="text-sm text-rust">Navigation is hidden until the owner verifies every visible scan's alignment and units.</p> : <div hidden={automatic}><NavigationPanel space={data.space} graph={data.graph} paths={data.paths} user={user} initialPath={search.get("path") ?? undefined} onRoute={onRoute} onSaved={refresh} /></div>}
        <label className="flex gap-2"><input type="checkbox" checked={showGraph} onChange={e => setShowGraph(e.target.checked)} />Show navigation graph</label>
        <button className="secondary-button" onClick={() => setResetToken(n => n + 1)}>Reset view</button>
        <label className="editor-grid">Space link<input readOnly value={`${window.location.origin}/spaces/${spaceId}`} onFocus={e => e.target.select()} /></label>
        <button className="secondary-button" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/spaces/${spaceId}`).then(() => setShareMessage("Link copied."), () => setShareMessage("Select and copy the link above.")); }}>Copy link</button>
        {shareMessage && <p role="status" className="text-sm">{shareMessage}</p>}
        {data.space.visibility === "private" && <p className="text-sm">This space requires access. Sharing its URL does not make it public.</p>}
        {owner && <SpaceEditor space={data.space} scans={data.scans} graph={data.graph} paths={data.paths} picked={picked} onChanged={refresh} />}
      </>}
    </aside>
    <section className="relative min-h-0 flex-1 text-paper" aria-label="Room and route viewer">
      {!!models.length && <Suspense fallback={<LoadingPanel label="Loading 3D viewer…" />}><SpaceViewer automaticNavigation navigationUnavailable={navigationUnavailable} onAutomaticChange={setAutomatic} models={models} nodes={alignmentWarning ? [] : data?.graph.nodes ?? []} edges={alignmentWarning ? [] : data?.graph.edges ?? []} route={alignmentWarning ? undefined : route?.nodes} showGraph={showGraph} resetToken={resetToken} onPick={owner ? setPicked : undefined} onReady={() => setLoading(false)} onError={message => { setAssetError(message); setLoading(false); }} /></Suspense>}
      {loading && data && !assetError && <LoadingPanel label="Downloading and building the 3D view…" />}
      {assetError && <p role="alert" className="absolute inset-x-4 top-4 rounded-xl bg-paper p-4 text-rust">Could not display the scan: {assetError}</p>}
      {!loading && !models.length && !assetError && data && <p className="p-6">No accessible GLB scans in this space.{owner ? " Upload one using Owner tools." : " Ask the owner to publish the room scan."}</p>}
      {!!models.length && <p className="pointer-events-none absolute right-3 bottom-3 rounded bg-night/80 px-3 py-2 text-sm">Drag to orbit · scroll or pinch to zoom{owner ? " · double-click to pick" : ""}</p>}
    </section>
  </main>;
}
