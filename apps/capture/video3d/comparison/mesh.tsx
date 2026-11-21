import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CaptureView } from "./CameraCanvas";
import { createStage, loadAssets, type Assets } from "./meshStage";
import "./style.css";
import "./mesh.css";

const planeMode = window.location.pathname.replace(/\/$/, "") === "/plane-compare";
if (planeMode) document.title = "Plane fill comparison · Path";

type Loaded = { assets: Assets; views: CaptureView[] };

function Viewer({ assets, views }: Loaded) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<ReturnType<typeof createStage> | null>(null);
  const [view, setView] = useState(views.length ? 0 : -1);
  const [solid, setSolid] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      stage.current = createStage(canvas.current!, assets, views[0]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    return () => { stage.current?.dispose(); stage.current = null; };
  }, [assets, views]);

  function showView(index: number) {
    setView(index);
    stage.current?.setView(views[index]);
  }
  function showSolid(enabled: boolean) {
    setSolid(enabled);
    stage.current?.setAppearance(enabled, highlight);
  }
  function showFills(enabled: boolean) {
    setHighlight(enabled);
    stage.current?.setAppearance(solid, enabled);
  }
  if (error) return <section role="alert">Could not display the comparison. {error}</section>;
  return <main className={planeMode ? "mesh-viewer plane-viewer" : "mesh-viewer"}>
    <header className="mesh-header">
      <h1>Path <span>/</span> {planeMode ? "Plane fill comparison" : "Hallway comparison"}</h1>
      <div className="controls">
        {views.length > 0 && <label>View <select value={view} onChange={e => showView(Number(e.target.value))}>
          <option value={-1}>Overview</option>
          {views.map((v, i) => <option value={i} key={i}>{v.label}</option>)}
        </select></label>}
        <button onClick={() => showView(view)}>Reset view</button>
      </div>
    </header>
    <div className="mesh-stage">
      <canvas ref={canvas} aria-label={planeMode ? "Synchronized views of the original mesh and plane fills" : "Synchronized 3D views of the OpenMVS point cloud and mesh"}/>
      <div className="mesh-pane">
        <h2>{planeMode ? "Current mesh" : "Point cloud"}</h2>
        <span>{assets.baseline ? `${assets.baseline.triangles.toLocaleString()} triangles` : `${assets.scan!.count.toLocaleString()} points`}</span>
      </div>
      <div className="mesh-pane">
        <h2>{planeMode ? "With plane fills" : solid ? "Solid mesh" : "Textured mesh"}</h2>
        <span>{planeMode ? `${assets.right.fillTriangles.toLocaleString()} fill triangles` : `${assets.right.triangles.toLocaleString()} triangles`}</span>
      </div>
    </div>
    <div className="mesh-footer">
      <span>Drag either view to orbit · scroll to zoom</span>
      {planeMode && <button className="highlight-fills" aria-pressed={highlight} disabled={!assets.right.fillTriangles}
        onClick={() => showFills(!highlight)}>Highlight fills</button>}
      <div className="switch" role="group" aria-label="Mesh appearance">
        <button aria-pressed={!solid} onClick={() => showSolid(false)}>Textured</button>
        <button aria-pressed={solid} onClick={() => showSolid(true)}>Solid</button>
      </div>
    </div>
  </main>;
}

function App() {
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState("");
  useEffect(() => {
    const stop = new AbortController();
    let resources: Assets | undefined;
    async function load() {
      const result = await fetch(planeMode ? "/api/plane-comparison" : "/api/mesh-comparison", { signal: stop.signal });
      if (!result.ok) throw new Error("Comparison information could not be loaded.");
      const { points, baseline, mesh, views } = await result.json();
      resources = await loadAssets(planeMode ? baseline : points, mesh, planeMode, stop.signal);
      if (stop.signal.aborted) resources.dispose();
      else setLoaded({ assets: resources, views });
    }
    load().catch(e => { if (!stop.signal.aborted) setError(String(e)); });
    return () => { stop.abort(); resources?.dispose(); };
  }, []);
  if (error) return <section role="alert">{error}</section>;
  if (!loaded) return <section role="status">Loading reconstruction and photo textures…</section>;
  return <Viewer {...loaded}/>;
}
createRoot(document.getElementById("root")!).render(<App/>);
