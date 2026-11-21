import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import SharePanel from "../components/SharePanel";
import VisibilityPicker from "../components/VisibilityPicker";
import {
  checkFile,
  formatBytes,
  parseViewerIds,
  updateSharing,
  uploadScan,
  UploadError,
  type ScanFormat,
  type UploadResult,
  type Visibility,
} from "../lib/scans";

type Phase =
  | { step: "choose" }
  | { step: "uploading"; progress: number }
  | { step: "done"; result: UploadResult; visibility: Visibility; viewerIds: string[]; warning?: string };

export default function Upload() {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<{ file: File; format: ScanFormat } | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("unlisted");
  const [viewerText, setViewerText] = useState("");
  const [phase, setPhase] = useState<Phase>({ step: "choose" });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    document.title = "New map · Path";
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
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  }

  const viewers = parseViewerIds(viewerText);

  async function upload() {
    if (!file) return;
    if (visibility === "private" && viewers.invalid.length) {
      setUploadError(`These aren't valid account IDs: ${viewers.invalid.join(", ")}`);
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
        signal: controller.signal,
        onProgress: (progress) => setPhase({ step: "uploading", progress }),
      });
      let viewerIds: string[] = [];
      let warning: string | undefined;
      if (visibility === "private" && viewers.ids.length) {
        try {
          viewerIds = (await updateSharing(result.shareId, "private", viewers.ids)).viewerIds;
        } catch (error) {
          warning = `Uploaded, but adding viewers failed: ${(error as Error).message} Try again below.`;
        }
      }
      setPhase({ step: "done", result, visibility, viewerIds, warning });
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
    setViewerText("");
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
          {phase.warning ? (
            <p role="alert" className="mb-4 rounded-lg bg-surface px-4 py-3 text-rust ring-1 ring-rust/30">
              {phase.warning}
            </p>
          ) : null}
          <SharePanel
            shareId={phase.result.shareId}
            sharePath={phase.result.sharePath}
            initialVisibility={phase.visibility}
            initialViewerIds={phase.viewerIds}
            onUploadAnother={reset}
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
              <span className="text-rust">1</span> Choose your scan
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

          <fieldset className="grid gap-3" disabled={uploading}>
            <legend className="mb-3 font-display text-xl font-extrabold">
              <span className="text-rust">2</span> Who can open it
            </legend>
            <VisibilityPicker name="upload-visibility" value={visibility} onChange={setVisibility} disabled={uploading} />
            {visibility === "private" ? (
              <label className="grid gap-1">
                <span className="font-bold">People who can view</span>
                <span className="text-sm text-muted">Account IDs, separated by commas. Leave empty for just you.</span>
                <input
                  value={viewerText}
                  onChange={(e) => setViewerText(e.target.value)}
                  placeholder="sam, anish"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="min-h-12 rounded-lg bg-surface px-3 font-mono ring-1 ring-forest/25 focus:ring-2 focus:ring-forest focus:outline-none"
                />
              </label>
            ) : null}
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
