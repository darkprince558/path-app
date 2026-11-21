import { useEffect, useState } from "react";
import { findRoute, savedRoute, type Route } from "../lib/navigation";
import { nodeLabel, request, send, type Graph, type SavedPath, type Space, type User } from "../lib/space-api";

export default function NavigationPanel({ space, graph, paths, user, initialPath, onRoute, onSaved }: {
  space: Space; graph: Graph; paths: SavedPath[]; user: User | null; initialPath?: string;
  onRoute: (route: Route | null) => void; onSaved: () => void;
}) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [error, setError] = useState("");
  const [route, setRoute] = useState<Route | null>(null);
  const [saved, setSaved] = useState(initialPath ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setSaved(initialPath ?? ""), [initialPath]);
  useEffect(() => {
    setRoute(null); onRoute(null); setError("");
    if (!saved) return;
    const controller = new AbortController();
    request<{ path: SavedPath }>(`/api/paths/${encodeURIComponent(saved)}`, { signal: controller.signal })
      .then(({ path }) => { if (controller.signal.aborted) return; const result = savedRoute(graph, path); setRoute(result); onRoute(result); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [saved, graph, onRoute]);
  function calculate() {
    setError("");
    try {
      const result = findRoute(graph, start, end);
      setRoute(result); onRoute(result);
      if (!result) setError("These locations are not connected in the allowed direction. Choose another start or destination.");
    } catch (e) { setRoute(null); onRoute(null); setError((e as Error).message); }
  }
  async function save() {
    if (!route || route.nodes.length < 2) return;
    setBusy(true); setError("");
    try {
      await send("/api/paths", "POST", { name, spaceId: space.id, visibility: space.visibility, nodeIds: route.nodes.map(n => n.id) });
      setName(""); onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="editor-grid" aria-label="Navigation">
    <h2 className="text-lg font-bold">Find a route</h2>
    <label>Saved route<select value={saved} onChange={e => setSaved(e.target.value)}><option value="">Choose locations</option>{paths.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    {!saved && <>
      <label>Start<select value={start} onChange={e => { setStart(e.target.value); setRoute(null); onRoute(null); }}><option value="">Choose start</option>{graph.nodes.map(n => <option key={n.id} value={n.id}>{nodeLabel(n, graph)}</option>)}</select></label>
      <label>Destination<select value={end} onChange={e => { setEnd(e.target.value); setRoute(null); onRoute(null); }}><option value="">Choose destination</option>{graph.nodes.map(n => <option key={n.id} value={n.id}>{nodeLabel(n, graph)}</option>)}</select></label>
      <button className="action-button" onClick={calculate} disabled={!start || !end}>Show route</button>
    </>}
    {route && <div role="status"><p>{route.nodes.length === 1 ? "You are already at this location." : `${route.nodes.length - 1} connected segments`}</p>
      <ol className="list-inside list-decimal text-sm">{route.nodes.map((n, i) => <li key={`${n.id}-${i}`}>{nodeLabel(n, graph)}</li>)}</ol></div>}
    {error && <p role="alert" className="text-rust">{error}</p>}
    {!graph.nodes.length && <p>The owner has not added navigation locations yet.</p>}
    {user && !saved && route && route.nodes.length > 1 && <>
      <label>Route name<input value={name} maxLength={200} onChange={e => setName(e.target.value)} /></label>
      <button className="action-button" disabled={busy || !name.trim()} onClick={() => void save()}>Save route</button>
    </>}
  </section>;
}
