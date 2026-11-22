import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import SharePanel from "../components/SharePanel";
import VisibilityPicker from "../components/VisibilityPicker";
import {
  checkFile,
  cleanMapName,
  formatBytes,
  MAX_NAME_LENGTH,
  mapEditId,
  uploadScan,
  UploadError,
  type ScanFormat,
  type UploadResult,
  type Visibility,
} from "../lib/scans";

type Phase =
  | { step: "choose" }
  | { step: "uploading"; progress: number }
  | { step: "done"; result: UploadResult; visibility: Visibility };

export default function Upload() {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<{ file: File; format: ScanFormat } | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("unlisted");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const nameId = useId();
  const [phase, setPhase] = useState<Phase>({ step: "choose" });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    document.title = "New map · Not 404";
    return () => abortRef.current?.abort();
  }, []);

  async function choose(chosen: File | undefined) {
    setUploadError(null);
    if (!chosen) return;
    const check = await checkFile(chosen);
    if ("problem" in check) {
      setFile(null);
      setFileProblem(check.problem);
    } else {
      setFile({ file: chosen, format: check.format });
      setFileProblem(null);
      // Suggest a name from the file ("eng-floor-2.ply" -> "eng floor 2") until the person types their own.
      if (!nameEdited) setName(chosen.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, MAX_NAME_LENGTH));
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  }

  const cleanedName = cleanMapName(name);

  async function upload() {
    if (!file) return;
    if (name.trim() && !cleanedName) {
      setUploadError(`Give the map a name of 1 to ${MAX_NAME_LENGTH} characters, or leave it empty.`);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setUploadError(null);
    setPhase({ step: "uploading", progress: 0 });
    try {
      const result = await uploadScan({
        file: file.file,
        format: file.format,
        visibility,
        name: cleanedName ?? undefined,
        signal: controller.signal,
        onProgress: (progress) => setPhase({ step: "uploading", progress }),
      });
      setPhase({ step: "done", result, visibility });
    } catch (error) {
      if (controller.signal.aborted) {
        setPhase({ step: "choose" });
        return;
      }
      setPhase({ step: "choose" });
      setUploadError(error instanceof UploadError ? error.message : "The upload failed. Try again.");
    } finally {
      abortRef.current = null;
    }
  }

  function reset() {
    setFile(null);
    setFileProblem(null);
    setName("");
    setNameEdited(false);
    setUploadError(null);
    setPhase({ step: "choose" });
    if (inputRef.current) inputRef.current.value = "";
  }

  const uploading = phase.step === "uploading";

  return (
    <div className="mx-auto max-w-lg">
      <Link to="/maps" className="text-sm font-bold text-rust underline underline-offset-4">
        ← Your maps
      </Link>
      <h1 className="mt-4 font-display text-4xl leading-none font-black">New map</h1>
      <p className="mt-3 text-lg text-muted">Upload a scan of a building, campus or trail. Choose who can open it, then share the link or QR code.</p>

      {phase.step === "done" ? (
        <div className="mt-8">
          {file?.format === "glb" && <Link
            to={phase.result.sharePath}
            className="mb-6 flex min-h-14 items-center justify-center rounded-full bg-coral px-6 text-lg font-bold text-ink"
          >Plan a route</Link>}
          {file?.format === "glb" && <p className="mb-6 text-muted">Open your map, then choose a start and destination on the floor. Your route is generated automatically.</p>}
          <SharePanel
            mapId={mapEditId(phase.result)}
            sharePath={phase.result.sharePath}
            initialVisibility={phase.visibility}
            footer={
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                <Link
                  to={`/maps/${phase.result.shareId}`}
                  className="font-bold text-rust underline underline-offset-4"
                >
                  Manage “{phase.result.name}”
                </Link>
                <button type="button" onClick={reset} className="font-bold text-rust underline underline-offset-4">
                  Upload another scan
                </button>
              </div>
            }
          />
        </div>
      ) : (
        <form
          className="mt-8 grid gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            void upload();
          }}
        >
          <section className="grid gap-3">
            <h2 className="font-display text-xl font-extrabold">
              <span aria-hidden="true" className="text-rust">1</span> Choose your scan
            </h2>
            <label
              htmlFor={inputId}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-6 text-center transition-colors has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-(--focus-ring) ${
                dragging ? "border-forest bg-surface ring-2 ring-forest ring-inset" : "border-forest/35 bg-surface"
              } ${uploading ? "pointer-events-none opacity-60" : ""}`}
            >
              <input
                id={inputId}
                ref={inputRef}
                type="file"
                accept=".ply,.glb,application/octet-stream,model/gltf-binary"
                className="sr-only"
                disabled={uploading}
                onChange={(e) => void choose(e.target.files?.[0])}
              />
              {file ? (
                <>
                  <span className="max-w-full truncate font-mono text-forest">{file.file.name}</span>
                  <span className="text-sm text-muted">
                    {file.format.toUpperCase()} · {formatBytes(file.file.size)} · tap to change
                  </span>
                </>
              ) : (
                <>
                  <span className="font-bold">Tap to choose a file</span>
                  <span className="text-sm text-muted">PLY point cloud or GLB model, up to 32 MB</span>
                </>
              )}
            </label>
            {fileProblem ? (
              <p role="alert" className="text-rust">
                {fileProblem}
              </p>
            ) : null}
          </section>

          <section className="grid gap-2">
            <h2 className="font-display text-xl font-extrabold">
              <label htmlFor={nameId}>
                <span aria-hidden="true" className="text-rust">2</span> Name it
              </label>
            </h2>
            <p id={`${nameId}-hint`} className="text-sm text-muted">
              What people see on the map card, for example “Engineering building, 2nd floor”.
            </p>
            <input
              id={nameId}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
              disabled={uploading}
              maxLength={MAX_NAME_LENGTH + 20}
              placeholder="Untitled map"
              aria-describedby={`${nameId}-hint`}
              className="min-h-12 rounded-lg bg-surface px-3 ring-1 ring-forest/25 focus:ring-2 focus:ring-forest focus:outline-none"
            />
          </section>

          <fieldset className="grid gap-3" disabled={uploading}>
            <legend className="mb-3 font-display text-xl font-extrabold">
              <span aria-hidden="true" className="text-rust">3</span> Who can open it
            </legend>
            <VisibilityPicker name="upload-visibility" value={visibility} onChange={setVisibility} disabled={uploading} />
          </fieldset>

          <div className="grid gap-3">
            {uploading ? (
              <div className="grid gap-2" role="status" aria-live="polite">
                <div className="flex justify-between text-sm">
                  <span className="font-bold">Uploading…</span>
                  <span className="font-mono">{Math.round(phase.progress * 100)}%</span>
                </div>
                <div
                  className="h-3 overflow-hidden rounded-full bg-forest/15"
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(phase.progress * 100)}
                >
                  <div className="h-full rounded-full bg-coral transition-[width]" style={{ width: `${phase.progress * 100}%` }} />
                </div>
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="justify-self-start font-bold text-rust underline underline-offset-4"
                >
                  Cancel upload
                </button>
              </div>
            ) : (
              <button
                type="submit"
                disabled={!file}
                className="min-h-14 rounded-full bg-coral px-6 text-lg font-bold text-ink active:scale-[0.98] disabled:bg-forest/15 disabled:text-forest/60"
              >
                Upload and get link
              </button>
            )}
            {uploadError ? (
              <p role="alert" className="rounded-lg bg-surface px-4 py-3 text-rust ring-1 ring-rust/30">
                {uploadError}
              </p>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
