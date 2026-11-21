import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BufferAttribute, BufferGeometry, Color, type InterleavedBufferAttribute } from "three";
import ScanViewer from "./src/components/ScanViewer";
import { parsePointCloud, type PointScan } from "./src/lib/ply";
import { CameraRequest, type CaptureView } from "./CameraCanvas";
import "./style.css";

type Method = 0 | 1;

function copyTriples(output: Float32Array, start: number, input: BufferAttribute | InterleavedBufferAttribute) {
  // PLYLoader may use normalized byte colors. The accessors preserve the
  // values the GPU sees for normalized, interleaved and float attributes.
  for (let i = 0; i < input.count; i++) {
    const offset = (start + i) * 3;
    output[offset] = input.getX(i);
    output[offset + 1] = input.getY(i);
    output[offset + 2] = input.getZ(i);
  }
}

function combine(scans: [PointScan, PointScan]) {
  // One guest canvas, camera and material. Selecting a method changes only
  // the vertex range, so zoom, point size, projection and orbit stay identical.
  const total = scans[0].count + scans[1].count;
  const positions = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const fallback = new Color("#A9C4AE");
  let start = 0;
  for (const scan of scans) {
    copyTriples(positions, start, scan.geometry.getAttribute("position"));
    if (scan.hasColor) copyTriples(colors, start, scan.geometry.getAttribute("color"));
    else for (let i = start; i < start + scan.count; i++) fallback.toArray(colors, i * 3);
    start += scan.count;
    scan.geometry.dispose();
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  geometry.setDrawRange(0, scans[0].count);
  const bounds = geometry.boundingSphere!;
  if (!bounds.radius) bounds.radius = 1;
  const count = Math.max(scans[0].count, scans[1].count);
  const scan: PointScan = { geometry, bounds, count, sourceCount: total, hasColor: true };
  return { scan, counts: scans.map(s => s.count) };
}

async function load(signal: AbortSignal) {
  const response = await fetch("/api/comparison", { signal });
  if (!response.ok) throw new Error("Could not read comparison details.");
  const { assets, views, labels } = await response.json() as {
    assets: [string, string]; views: CaptureView[]; labels: [string, string];
  };
  const [a, b] = await Promise.all(assets.map(async (asset, i) => {
    const file = await fetch(asset, { signal });
    if (!file.ok) throw new Error(`Could not load the ${labels[i]} file.`);
    return parsePointCloud(await file.arrayBuffer());
  }));
  return { ...combine([a!, b!]), views, labels };
}

type Comparison = Awaited<ReturnType<typeof load>>;

function Compare({ data }: { data: Comparison }) {
  const [method, setMethod] = useState<Method>(0);
  const [view, setView] = useState(data.views.length ? 0 : -1);
  const [reset, setReset] = useState(0);
  const request = useMemo(() => ({ view: data.views[view], revision: reset }), [data, view, reset]);

  useLayoutEffect(() => {
    data.scan.geometry.setDrawRange(method === 0 ? 0 : data.counts[0]!, data.counts[method]!);
  }, [data, method]);
  useEffect(() => {
    function select(event: KeyboardEvent) {
      if (event.metaKey || event.altKey || event.ctrlKey || event.target instanceof HTMLSelectElement) return;
      if (event.key.toLowerCase() === "a") setMethod(0);
      if (event.key.toLowerCase() === "b") setMethod(1);
    }
    window.addEventListener("keydown", select);
    return () => window.removeEventListener("keydown", select);
  }, []);

  return <main>
    <h1>Path <span>/</span> Surface comparison</h1>
    <div className="switch" role="group" aria-label="Surface method">
      {data.labels.map((name, i) => <button key={name} aria-pressed={method === i} onClick={() => setMethod(i as Method)}>
        {name} <kbd>{i === 0 ? "A" : "B"}</kbd>
      </button>)}
    </div>
    <div className="viewport" aria-label={`${data.labels[method]} 3D point cloud`}>
      <CameraRequest.Provider value={request}><ScanViewer scan={data.scan} resetToken={reset} /></CameraRequest.Provider>
    </div>
    <div className="footer">
      <div className="info"><strong aria-live="polite">{data.labels[method]} · {data.counts[method]!.toLocaleString()} points</strong><span>Drag to orbit · scroll to zoom</span></div>
      <div className="controls">
        {data.views.length > 0 && <label>View <select value={view} onChange={e => { setView(Number(e.target.value)); setReset(r => r + 1); }}>
          <option value={-1}>Overview</option>
          {data.views.map((v, i) => <option value={i} key={i}>{v.label}</option>)}
        </select></label>}
        <button onClick={() => setReset(r => r + 1)}>Reset view</button>
      </div>
    </div>
  </main>;
}

function App() {
  const [data, setData] = useState<Comparison>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let loaded: Comparison | undefined;
    load(controller.signal).then(value => {
      loaded = value;
      if (controller.signal.aborted) value.scan.geometry.dispose();
      else setData(value);
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); });
    return () => { controller.abort(); loaded?.scan.geometry.dispose(); };
  }, []);
  if (!data) return <section role="status">{error || "Loading both point clouds…"}</section>;
  return <Compare data={data} />;
}

createRoot(document.getElementById("root")!).render(<App />);
