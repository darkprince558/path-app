import { useEffect, useRef, useState } from "react";
import {
  MAX_DURATION_MS, startRecording, type CaptureMeter, type Recording, type Take,
} from "../lib/phone-recording";
import {
  CaptureRequestError, captureRequest, clearTake, organizerKey, readTake, savedJob, saveJob,
  shareUrl, writeTake, type CaptureStatus,
} from "../lib/recording-session";
import "./record.css";

type Phase = "loading" | "idle" | "starting" | "recording" | "saving" | "review" | "uploading" | "job";
const emptyMeter: CaptureMeter = { gyro: 0, accel: 0, elapsed: 0, permission: "unavailable" };
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
};
const message = (error: unknown) => error instanceof Error ? error.message : "The recording could not be completed.";

function VideoPreview({ stream, clip }: { stream: MediaStream | null; clip?: Blob }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (stream) {
      video.srcObject = stream;
      void video.play().catch(() => {}); // muted inline preview can resume when the page is visible
      return () => { video.srcObject = null; };
    }
    if (clip) {
      const url = URL.createObjectURL(clip);
      video.src = url;
      return () => { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); };
    }
  }, [stream, clip]);
  return <video ref={ref} playsInline muted autoPlay={Boolean(stream)} controls={Boolean(clip)}
    aria-label={clip ? "Recorded hallway video" : "Live camera preview"} />;
}

function TrackingResult({ summary }: { summary?: CaptureStatus["motionSummary"] }) {
  if (!summary || !Number.isInteger(summary.registeredFrames) || !summary.sampledFrames) return null;
  const gaps = summary.missingIntervalsSeconds || [];
  const partial = gaps.length > 0 || summary.registeredFrames! < summary.sampledFrames;
  const times = gaps.slice(0, 4).map(([a, b]) => a.toFixed(1) + "–" + b.toFixed(1) + " s");
  return <div className="rec-sensors">
    <h2>{partial ? "Partial camera path" : "Camera tracking"}</h2>
    <p>{summary.registeredFrames} of {summary.sampledFrames} sampled views registered.</p>
    {partial && <p>Review the missing stretches{times.length ? " at " + times.join(", ") : ""}
      {gaps.length > times.length ? " and " + (gaps.length - times.length) + " more" : ""}. Record another take if the turn is missing.</p>}
    {!partial && summary.supportedFraction !== undefined && summary.supportedFraction < 1 &&
      <p>Some registered views have weak visual support. Check the turn in 3D.</p>}
    {summary.samplingReason && <p>{summary.samplingReason}</p>}
  </div>;
}

export default function Record() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [key, setKey] = useState("");
  const [take, setTake] = useState<Take>();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [meter, setMeter] = useState<CaptureMeter>(emptyMeter);
  const [job, setJob] = useState("");
  const [result, setResult] = useState<CaptureStatus>();
  const [problem, setProblem] = useState("");
  const [storageNote, setStorageNote] = useState("");
  const [transfer, setTransfer] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  const active = useRef<Recording | null>(null);
  const busy = useRef(false);
  const credential = useRef("");

  useEffect(() => {
    const session = new AbortController();
    lifetime.current = session;
    // Retain the in-memory key when StrictMode replays an effect and storage is disabled.
    credential.current = organizerKey() || credential.current;
    setKey(credential.current);
    if (!credential.current) {
      setPhase("idle");
      return () => session.abort();
    }
    const id = savedJob();
    void readTake().catch(() => undefined).then((draft) => {
      if (session.signal.aborted) return;
      setTake(draft);
      if (id && credential.current) { setJob(id); setPhase("job"); }
      else setPhase(draft ? "review" : "idle");
    });
    return () => { session.abort(); };
  }, []);

  useEffect(() => {
    if (phase !== "job" || !job || !key) return;
    const controller = new AbortController();
    let timer = 0;
    let wait = 1800;
    const poll = async () => {
      try {
        const state = await captureRequest(key, job, "", "GET", controller.signal);
        if (controller.signal.aborted) return;
        setProblem("");
        setResult(state);
        if (state.status === "ready" || state.status === "failed") return;
        if (state.status === "uploading") {
          saveJob("");
          setPhase(take ? "review" : "idle");
          setProblem(take ? "The upload is incomplete. Send this take again." : "The upload is incomplete. Start a new recording.");
          return;
        }
        wait = 1800;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof CaptureRequestError && error.status === 404) {
          saveJob("");
          setPhase(take ? "review" : "idle");
          setProblem("This Mac no longer has that job.");
          return;
        }
        setProblem(error instanceof CaptureRequestError ? error.message : "Reconnecting to your Mac…");
        if (error instanceof CaptureRequestError && [401, 403].includes(error.status)) return;
        wait = Math.min(12_000, wait * 2);
      }
      timer = window.setTimeout(poll, wait);
    };
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [job, key, phase, take]);

  async function record() {
    const signal = lifetime.current?.signal;
    if (busy.current || !key || signal?.aborted || !signal) return;
    busy.current = true; setProblem(""); setStorageNote(""); setMeter(emptyMeter); setPhase("starting");
    try {
      const rec = await startRecording(signal, setMeter);
      active.current = rec; setStream(rec.stream); setPhase("recording");
      const draft = await rec.finished;
      active.current = null;
      if (signal.aborted) return;
      setStream(null); setTake(draft); setPhase("saving");
      try { await writeTake(draft); }
      catch { setStorageNote("Phone storage is unavailable. Keep this page open until the upload finishes."); }
      if (!signal.aborted) setPhase("review");
    } catch (error) {
      if (!signal.aborted) {
        setProblem(error instanceof DOMException && error.name === "NotAllowedError"
          ? "Camera access was denied. Allow camera access for this site in your browser, then try again."
          : message(error));
        active.current = null; setStream(null); setPhase("idle");
      }
    } finally { busy.current = false; }
  }

  function showJob(id: string, state: CaptureStatus) {
    saveJob(id); setJob(id); setResult(state); setPhase("job"); setProblem("");
  }
  async function processTake() {
    const signal = lifetime.current?.signal;
    if (busy.current || !take || !key || !signal || signal.aborted) return;
    busy.current = true; saveJob(take.id); setProblem(""); setPhase("uploading"); setTransfer("Connecting to Mac…");
    try {
      let previous: CaptureStatus | undefined;
      try { previous = await captureRequest(key, take.id, "", "GET", signal); }
      catch (error) { if (!(error instanceof CaptureRequestError && error.status === 404)) throw error; }
      if (previous && previous.status !== "uploading") { showJob(take.id, previous); return; }
      setTransfer("Uploading video…");
      await captureRequest(key, take.id, "/video", "PUT", signal, take.video);
      setTransfer("Uploading motion samples…");
      await captureRequest(key, take.id, "/motion", "PUT", signal, JSON.stringify(take.motion));
      setTransfer("Starting reconstruction…");
      const state = await captureRequest(key, take.id, "/process", "POST", signal);
      if (!signal.aborted) showJob(take.id, state);
    } catch (error) {
      if (!signal.aborted) { setProblem(message(error)); setPhase("review"); }
    } finally { busy.current = false; }
  }
  async function retryJob() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || busy.current) return;
    busy.current = true; setPhase("uploading"); setTransfer("Restarting reconstruction…"); setProblem("");
    try { const state = await captureRequest(key, job, "/process", "POST", signal); if (!signal.aborted) showJob(job, state); }
    catch (error) { if (!signal.aborted) { setProblem(message(error)); setPhase("job"); } }
    finally { busy.current = false; }
  }
  async function newTake() {
    if (busy.current) return;
    if (phase === "review" && !window.confirm("Discard this take from this phone?")) return;
    busy.current = true;
    try {
      if (take) await clearTake();
    } catch {
      if (!storageNote) { setProblem("Could not remove the saved take from this phone. Try again."); return; }
    } finally { busy.current = false; }
    saveJob(""); setJob(""); setResult(undefined); setTake(undefined); setMeter(emptyMeter);
    setCopyStatus(""); setProblem(""); setStorageNote(""); setPhase("idle");
  }
  const guest = result?.status === "ready" ? shareUrl(result.sharePath) : "";
  const shareInput = useRef<HTMLInputElement>(null);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(guest);
      setCopyStatus("Link copied.");
    } catch {
      shareInput.current?.focus(); shareInput.current?.select();
      setCopyStatus("Select Copy to copy the highlighted link.");
    }
  }
  async function nativeShare() {
    try { await navigator.share({ title: "Hallway scan · Path", url: guest }); }
    catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) void copyLink(); }
  }

  const live = phase === "recording";
  const processing = phase === "job";
  const elapsed = take?.motion.durationMs ?? meter.elapsed;
  const counts = take
    ? { gyro: take.motion.samples.filter(s => s.rotationRate).length,
        accel: take.motion.samples.filter(s => s.acceleration || s.accelerationIncludingGravity).length }
    : meter;
  const permission = take?.motion.permission ?? meter.permission;
  const noMotion = !counts.gyro && !counts.accel;
  const motionState = permission === "denied" ? "Permission declined · video only"
    : permission === "unavailable" ? "Sensors unavailable · video only"
    : noMotion ? (live ? "Waiting for readings" : "No readings received · video only") : "Motion captured";
  const waiting = phase === "loading" || phase === "starting" || phase === "saving";
  let heading = "Record a hallway";
  let instruction = "Keep the same corner or doorway in view as you walk around the turn.";
  if (phase === "starting") { heading = "Opening camera"; instruction = "Allow camera and motion access when your phone asks."; }
  if (live) { heading = "Recording"; instruction = "Keep this page visible. Stop a few steps beyond the turn."; }
  if (phase === "saving" || phase === "review") { heading = "Review your take"; instruction = "Check that the turn is visible before sending the recording to your Mac."; }
  if (phase === "uploading") { heading = "Sending your scan"; instruction = "Keep this page open while the files transfer."; }
  if (processing) {
    heading = result?.status === "ready" ? "Your scan is ready" : result?.status === "failed" ? "Scan needs attention" : "Building your scan";
    instruction = result?.status === "ready" ? "Anyone with the unlisted link can open the 3D scan on another phone."
      : result?.status === "failed" ? (result.error || "Reconstruction could not finish on the Mac.")
      : (result?.stage || "Your Mac is preparing the reconstruction. You can return to this page to check progress.");
  }
  return (
    <main className="rec-page">
      <header className="rec-nav"><a href="/" aria-label="Path home">Path<span aria-hidden="true">.</span></a><span>Recorder</span></header>
      <div className="rec-layout">
        <section className="rec-camera" aria-label="Video">
          {stream || take ? <VideoPreview stream={stream} clip={take?.video}/>
            : <div className="rec-viewfinder"><span className="rec-target" aria-hidden="true"/><span>Camera preview</span></div>}
          {(live || take) && <span className="rec-timer">{live && <i/>}{clock(elapsed)}</span>}
        </section>
        <section className="rec-panel" aria-label="Recording controls">
          <h1>{heading}</h1>
          <p className="rec-instruction">{instruction}</p>
          {(live || take) && <div className="rec-sensors">
            <h2>Motion data</h2><p>{motionState}</p>
            <dl><div><dt>Gyroscope samples</dt><dd>{counts.gyro.toLocaleString()}</dd></div>
              <div><dt>Accelerometer samples</dt><dd>{counts.accel.toLocaleString()}</dd></div></dl>
          </div>}
          {phase === "review" && take?.endedReason && <p className="rec-notice">{take.endedReason}</p>}
          {storageNote && <p className="rec-notice">{storageNote}</p>}
          {problem && <p className="rec-notice" role="alert">{problem}</p>}
          {!key && phase !== "loading" && <p className="rec-notice">Open the organizer recorder link shown on your Mac to start a scan.</p>}
          {phase === "idle" && <>
            <button className="rec-primary" onClick={record} disabled={!key}><i className="rec-dot" aria-hidden="true"/>Start recording</button>
            <p className="rec-caption">Up to {MAX_DURATION_MS / 1000} seconds · Rear camera · Audio off</p></>}
          {waiting && <p className="rec-progress" role="status">{phase === "loading" ? "Loading recorder…" : phase === "starting" ? "Waiting for camera…" : "Saving this take…"}</p>}
          {live && <button className="rec-primary" onClick={() => { active.current?.stop(); setPhase("saving"); }}><i className="rec-square" aria-hidden="true"/>Stop recording</button>}
          {phase === "review" && <>
            <button className="rec-primary" onClick={processTake} disabled={!key}>Process on Mac</button>
            <p className="rec-caption">Uploads the video and motion data to your Mac and creates an unlisted 3D link.</p>
            <button className="rec-secondary" onClick={newTake}>Discard take</button></>}
          {phase === "uploading" && <p className="rec-progress" role="status">{transfer}</p>}
          {processing && result?.status === "ready" && (guest ? <>
            <TrackingResult summary={result.motionSummary}/>
            <a className="rec-primary" href={guest}>Open 3D scan</a>
            <label className="rec-link-label" htmlFor="rec-share">Guest link</label>
            <input id="rec-share" ref={shareInput} className="rec-link" value={guest} readOnly/>
            <div className="rec-share-buttons"><button className="rec-secondary" onClick={copyLink}>Copy link</button>
              {typeof navigator.share === "function" && <button className="rec-secondary" onClick={nativeShare}>Share link</button>}</div>
            <p className="rec-caption" role="status">{copyStatus}</p>
          </> : <p role="alert">The Mac returned an invalid guest link. Reload this page to check again.</p>)}
          {processing && result?.status === "failed" && <button className="rec-primary" onClick={retryJob}>Retry processing</button>}
          {processing && (result?.status === "ready" || result?.status === "failed") &&
            <button className="rec-secondary" onClick={newTake}>New recording</button>}
        </section>
      </div>
    </main>
  );
}
