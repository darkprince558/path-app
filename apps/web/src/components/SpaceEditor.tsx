import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { alignmentControls, alignmentMatrix, calibrationScale, IDENTITY } from "../lib/alignment";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "../lib/scans";
import { coordinates, nodeLabel, request, scanAligned, send, type Graph, type NavNode, type Position, type SavedPath, type Scan, type Space } from "../lib/space-api";

export interface PickedPoint { scanId: string; point: Position; localPoint: Position }
const zero = { x: 0, y: 0, z: 0 };

function VectorFields({ label, value, onChange }: { label: string; value: Position; onChange: (v: Position) => void }) {
  return <fieldset><legend className="text-sm">{label}</legend><div className="grid grid-cols-3 gap-2">{(["x", "y", "z"] as const).map(axis =>
    <label key={axis}>{axis.toUpperCase()}<input aria-label={`${label} ${axis}`} type="number" step="any" required value={value[axis]} onChange={e => onChange({ ...value, [axis]: e.target.valueAsNumber })} /></label>)}</div></fieldset>;
}

export default function SpaceEditor({ space, scans, graph, paths, picked, onChanged }: {
  space: Space; scans: Scan[]; graph: Graph; paths: SavedPath[]; picked: PickedPoint | null; onChanged: () => void;
}) {
  const [selected, setSelected] = useState("");
  const [matrix, setMatrix] = useState(JSON.stringify(IDENTITY));
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState<Position>(zero);
  const [translation, setTranslation] = useState<Position>(zero);
  const [position, setPosition] = useState<Position>(zero);
  const [a, setA] = useState<PickedPoint | null>(null);
  const [b, setB] = useState<PickedPoint | null>(null);
  const [measured, setMeasured] = useState(1);
  const [calibration, setCalibration] = useState<Record<string, unknown> | undefined>();
  const [alignmentChanged, setAlignmentChanged] = useState(false);
  const [metricVerified, setMetricVerified] = useState(false);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [eventId, setEventId] = useState("");
  const selectedScan = scans.find(s => s.id === selected);
  const frame = coordinates(space);
  // Nodes explicitly tied to other scans do not freeze a new scan's alignment.
  const graphExists = graph.nodes.some(n => n.metadata?.scanId === selected || !n.metadata?.scanId);
  const unverifiedScans = scans.some(s => s.status === "ready" && s.format === "glb" && !scanAligned(s, space));
  useEffect(() => { setPosition(picked?.point ?? zero); }, [picked]);
  useEffect(() => {
    const values = selectedScan?.transform ?? IDENTITY;
    setMatrix(JSON.stringify(values)); setA(null); setB(null);
    const controls = alignmentControls(values);
    setScale(controls?.scale ?? 1); setRotation(controls?.rotation ?? zero); setTranslation(controls?.translation ?? zero);
    setVerified(selectedScan?.metadata.alignmentVerified === true); setAlignmentChanged(false);
    const declared = selectedScan?.metadata.coordinateSystem as { units?: string; calibrated?: boolean } | undefined;
    setMetricVerified(declared?.units === "metres" && declared.calibrated === true);
    setCalibration(selectedScan?.metadata.calibration as Record<string, unknown> | undefined);
  }, [selectedScan]);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); setNotice("Saved."); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function transform(): number[] {
    const value: unknown = JSON.parse(matrix);
    if (!Array.isArray(value) || value.length !== 16 || !value.every(v => typeof v === "number" && Number.isFinite(v))) throw new Error("Enter a matrix containing 16 finite numbers.");
    return value as number[];
  }
  function metadata() {
    const result = { ...selectedScan?.metadata };
    delete result.calibration;
    return { ...result, coordinateSystem: { ...frame, calibrated: frame.units === "metres" && metricVerified }, alignmentVerified: verified, alignmentSource: verified && alignmentChanged ? "owner" : result.alignmentSource ?? "owner",
      ...(calibration ? { calibration } : {}) };
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await perform(async () => {
      const file = form.get("file");
      if (!(file instanceof File) || !file.size || file.size > MAX_UPLOAD_BYTES) throw new Error(`Choose a GLB file no larger than ${MAX_UPLOAD_LABEL}.`);
      form.set("transform", JSON.stringify(transform())); form.set("metadata", JSON.stringify(metadata()));
      await request(`/api/spaces/${space.id}/scans`, { method: "POST", body: form });
    });
  }
  function calibrate() {
    setError("");
    try {
      if (!a || !b || a.scanId !== selected || b.scanId !== selected) throw new Error("Pick both reference points on the selected scan.");
      const next = calibrationScale(a.localPoint, b.localPoint, measured);
      const current = alignmentControls(transform());
      if (!current) throw new Error("Two-point calibration requires a uniform-scale alignment. Restore a uniform transform first.");
      setScale(next); setCalibration({ sourceDistance: measured / next, measuredDistanceMetres: measured, scale: next });
      setRotation(current.rotation); setTranslation(current.translation); setVerified(false); setMetricVerified(false);
      setMatrix(JSON.stringify(alignmentMatrix(next, current.rotation, current.translation)));
    } catch (e) { setError((e as Error).message); }
  }
  return <details className="border-t border-forest/20 pt-3"><summary className="cursor-pointer font-bold">Owner tools</summary>
    <div className="editor-grid mt-3">
      {error && <p role="alert" className="text-rust">{error}</p>}{notice && <p role="status">{notice}</p>}
      <details><summary className="cursor-pointer">Upload and align scans</summary><div className="editor-grid mt-3">
        <label>Scan<select aria-label="Scan" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Upload a new scan</option>{scans.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        {selectedScan && <label>Scan sharing<select disabled={busy} value={selectedScan.visibility} onChange={e => void perform(() => send(`/api/scans/${selected}`, "PATCH", { visibility: e.target.value }))}><option value="private">Private</option>{space.visibility === "public" && <option value="public">Public</option>}</select></label>}
        {graphExists && selectedScan && <p className="text-sm">Alignment is locked after navigation nodes are added. This keeps the recorded route in place.</p>}
        <fieldset disabled={busy || (graphExists && !!selectedScan)} className="editor-grid">
          <p className="text-sm">Align the floor and choose the space origin before adding locations. Coordinates use {frame.units === "metres" ? "metres" : "relative units"}.</p>
          <label>Uniform scale<input type="number" min="0.000001" step="any" value={scale} onChange={e => { setScale(e.target.valueAsNumber); }} /></label>
          <VectorFields label="Rotation in degrees" value={rotation} onChange={setRotation} />
          <VectorFields label="Position" value={translation} onChange={setTranslation} />
          <button className="secondary-button" onClick={() => { try { setMatrix(JSON.stringify(alignmentMatrix(scale, rotation, translation))); setCalibration(undefined); setVerified(false); setMetricVerified(false); setError(""); } catch (e) { setError((e as Error).message); } }}>Use these alignment values</button>
          <label>Scan-to-space matrix<textarea rows={4} value={matrix} onChange={e => { setMatrix(e.target.value); setCalibration(undefined); setVerified(false); setMetricVerified(false); }} /></label>
          {selectedScan && frame.units === "metres" && <div className="editor-grid">
            <p className="text-sm">Double-click two recognizable points on this scan. Enter the distance measured at the venue.</p>
            <button className="secondary-button" disabled={!picked || picked.scanId !== selected} onClick={() => setA(picked)}>Use picked point A{a ? " ✓" : ""}</button>
            <button className="secondary-button" disabled={!picked || picked.scanId !== selected} onClick={() => setB(picked)}>Use picked point B{b ? " ✓" : ""}</button>
            <label>Measured distance (metres)<input type="number" min="0.000001" step="any" value={measured} onChange={e => setMeasured(e.target.valueAsNumber)} /></label>
            <button className="secondary-button" disabled={!a || !b} onClick={calibrate}>Calculate scale</button>
          </div>}
        </fieldset>
        {selectedScan?.sourceRevisionId && <button className="secondary-button" disabled={busy} onClick={() => void perform(() => send(`/api/scans/${selected}/calibration`, "POST", {}))}>Restore validated LiDAR calibration</button>}
        {frame.units === "metres" && <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={metricVerified} onChange={e => setMetricVerified(e.target.checked)} />I independently verified this scan's metric scale (metres).</label>}
        <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={verified} onChange={e => { setVerified(e.target.checked); setAlignmentChanged(true); }} />I verified the floor is Y-up and the origin and alignment match this space. Scale is verified separately.</label>
        {selectedScan && <button className="action-button" disabled={busy} onClick={() => void perform(() => send(`/api/scans/${selected}`, "PATCH", { transform: graphExists ? selectedScan.transform : transform(), metadata: metadata() }))}>{graphExists ? "Save alignment confirmation" : "Save scan alignment"}</button>}
        {!selectedScan && <form onSubmit={upload} className="editor-grid">
          <label>Scan name<input name="name" required maxLength={200} /></label>
          <label>Textured GLB<input name="file" type="file" accept=".glb,model/gltf-binary" required /></label>
          <label>Scan sharing<select name="visibility" defaultValue="private"><option value="private">Private</option>{space.visibility === "public" && <option value="public">Public</option>}</select></label>
          <button className="action-button" disabled={busy}>Upload GLB</button>
        </form>}
      </div></details>
      <details><summary className="cursor-pointer">Locations and connections</summary><div className="editor-grid mt-3">
        <p className="text-sm">Double-click a visible floor surface to pick a location, or enter coordinates. Add only connections you have checked by walking the route.</p>
        {unverifiedScans && <p className="text-sm text-rust">Verify and save every scan's alignment above before adding navigation locations.</p>}
        <form className="editor-grid" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void perform(() => send(`/api/spaces/${space.id}/graph/nodes`, "POST", { ...position, metadata: { name: data.get("name"), ...(picked ? { scanId: picked.scanId } : {}) } })); }}>
          <label>Location name<input name="name" required maxLength={200} /></label>
          <VectorFields label="Location" value={position} onChange={setPosition} />
          <button className="action-button" disabled={busy || unverifiedScans}>Add location</button>
        </form>
        <form className="editor-grid" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void perform(async () => {
          const from = graph.nodes.find(n => n.id === data.get("from")), to = graph.nodes.find(n => n.id === data.get("to"));
          if (!from || !to || from.id === to.id) throw new Error("Select two different locations.");
          const distance = Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z);
          if (distance <= 0) throw new Error("The two locations occupy the same position.");
          await send(`/api/spaces/${space.id}/graph/edges`, "POST", { fromNodeId: from.id, toNodeId: to.id, distance, bidirectional: data.get("both") === "on" });
        }); }}>
          <NodeSelect label="Connect from" name="from" graph={graph} /><NodeSelect label="Connect to" name="to" graph={graph} />
          <label className="flex gap-2"><input type="checkbox" name="both" defaultChecked />Allow travel both ways</label>
          <button className="action-button" disabled={busy || graph.nodes.length < 2}>Add connection</button>
        </form>
        <form className="editor-grid" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void perform(() => send("/api/destinations", "POST", { spaceId: space.id, nodeId: data.get("node"), name: data.get("name") })); }}>
          <label>Destination name<input name="name" required maxLength={200} /></label><NodeSelect label="Destination location" name="node" graph={graph} />
          <button className="action-button" disabled={busy || !graph.nodes.length}>Add destination</button>
        </form>
      </div></details>
      <details><summary className="cursor-pointer">Share this environment</summary><div className="editor-grid mt-3">
        <label>Space sharing<select value={space.visibility} disabled={busy} onChange={e => void perform(() => send(`/api/spaces/${space.id}`, "PATCH", { visibility: e.target.value }))}><option value="private">Private</option><option value="public">Public</option></select></label>
        <p className="text-sm">Public space links show only public scans. Change each intended scan's sharing above.</p>
        {space.visibility === "public" && <form className="editor-grid" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void perform(async () => {
          const result = await send<{ event: { id: string } }>("/api/events", "POST", { name: data.get("name"), visibility: "public", spaceIds: [space.id], pathIds: paths.filter(p => p.visibility === "public").map(p => p.id), destinationIds: graph.destinations.map(d => d.id) }); setEventId(result.event.id);
        }); }}><label>Event name<input name="name" required maxLength={200} /></label><button disabled={busy} className="action-button">Create public event link</button></form>}
        {eventId && <Link className="underline" to={`/events/${eventId}`}>Open shared event</Link>}
      </div></details>
    </div>
  </details>;
}

function NodeSelect({ label, name, graph }: { label: string; name: string; graph: Graph }) {
  return <label>{label}<select name={name} required><option value="">Choose location</option>{graph.nodes.map((n: NavNode) => <option key={n.id} value={n.id}>{nodeLabel(n, graph)}</option>)}</select></label>;
}
