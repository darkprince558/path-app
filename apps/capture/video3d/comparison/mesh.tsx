import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CaptureView } from "./CameraCanvas";
import { createStage, loadAssets, type Assets } from "./meshStage";
import "./style.css";
import "./mesh.css";

type Loaded = { assets: Assets; views: CaptureView[] };

function Viewer({ assets, views }: Loaded) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<ReturnType<typeof createStage> | null>(null);
  const [view, setView] = useState(views.length ? 0 : -1);
  const [solid, setSolid] = useState(false);
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
    stage.current?.setSolid(enabled);
  }
  if (error) return <section role="alert">Could not display the comparison. {error}</section>;
  return <main className="mesh-viewer">
    <header className="mesh-header">
      <h1>Path <span>/</span> Hallway comparison</h1>
      <div className="controls">
        {views.length > 0 && <label>View <select value={view} onChange={e => showView(Number(e.target.value))}>
          <option value={-1}>Overview</option>
          {views.map((v, i) => <option value={i} key={i}>{v.label}</option>)}
        </select></label>}
        <button onClick={() => showView(view)}>Reset view</button>
      </div>
    </header>
    <div className="mesh-stage">
      <canvas ref={canvas} aria-label="Synchronized 3D views of the OpenMVS point cloud and mesh"/>
      <div className="mesh-pane" aria-label="Point cloud">
        <h2>Point cloud</h2><span>{assets.scan.count.toLocaleString()} points</span>
      </div>
      <div className="mesh-pane" aria-label={solid ? "Solid mesh" : "Textured mesh"}>
        <h2>{solid ? "Solid mesh" : "Textured mesh"}</h2><span>{assets.triangles.toLocaleString()} triangles</span>
      </div>
    </div>
    <div className="mesh-footer">
      <span>Drag either view to orbit · scroll to zoom</span>
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
      const result = await fetch("/api/mesh-comparison", { signal: stop.signal });
      if (!result.ok) throw new Error("Comparison information could not be loaded.");
      const { points, mesh, views } = await result.json();
      resources = await loadAssets(points, mesh, stop.signal);
      if (stop.signal.aborted) resources.dispose();
      else setLoaded({ assets: resources, views });
    }
    load().catch(e => { if (!stop.signal.aborted) setError(String(e)); });
    return () => { stop.abort(); resources?.dispose(); };
  }, []);
  if (error) return <section role="alert">{error}</section>;
  if (!loaded) return <section role="status">Loading point cloud and photo textures…</section>;
  return <Viewer {...loaded}/>;
}
createRoot(document.getElementById("root")!).render(<App/>);
