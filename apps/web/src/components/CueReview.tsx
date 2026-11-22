import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
  cleanInstruction,
  CueError,
  fetchRevisionCues,
  framePath,
  MAX_INSTRUCTION_LENGTH,
  updateCue,
  type Cue,
  type CueConfidence,
  type CueStatus,
} from "../lib/cues";

/*
 * Owner's review of Gemini's landmark directions on Manage map. Gemini drafts a direction
 * for each turn from the scan's photos; the owner accepts, edits or rejects it. Guests see
 * only approved directions, labelled "Approved by the map owner".
 */

type State =
  | { phase: "loading" }
  | { phase: "ready"; cues: Cue[] }
  | { phase: "error"; message: string };

const STATUS_LABEL: Record<CueStatus, string> = {
  draft: "Waiting for review",
  approved: "Approved",
  rejected: "Rejected",
  abstained: "No clear landmark",
};

const STATUS_STYLE: Record<CueStatus, string> = {
  draft: "bg-paper text-forest ring-forest/30",
  approved: "bg-forest text-paper ring-forest",
  rejected: "bg-paper text-rust ring-rust/40",
  abstained: "bg-paper text-muted ring-forest/20",
};

const CONFIDENCE_LABEL: Record<CueConfidence, string> = {
  high: "Gemini is confident",
  medium: "Gemini is fairly sure",
  low: "Gemini is unsure, so check the photo",
};

export default function CueReview({ shareId, revisionId }: { shareId: string; revisionId?: string | null }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!revisionId) return;
    const controller = new AbortController();
    setState({ phase: "loading" });
    fetchRevisionCues(revisionId, controller.signal)
      .then((cues) => setState({ phase: "ready", cues }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "error", message: error instanceof CueError ? error.message : "Couldn't load the directions." });
      });
    return () => controller.abort();
  }, [revisionId, attempt]);

  const replace = (cue: Cue) =>
    setState((current) =>
      current.phase === "ready" ? { phase: "ready", cues: current.cues.map((c) => (c.id === cue.id ? cue : c)) } : current,
    );

  const counts =
    state.phase === "ready"
      ? {
          waiting: state.cues.filter((c) => c.status === "draft" || c.status === "abstained").length,
          approved: state.cues.filter((c) => c.status === "approved").length,
          rejected: state.cues.filter((c) => c.status === "rejected").length,
        }
      : null;

  return (
    <section aria-labelledby="cues-title" className="grid gap-4">
      <div>
        <h2 id="cues-title" className="font-display text-xl font-extrabold">
          Landmark directions
        </h2>
        <p className="mt-1 text-muted">
          Gemini suggests a direction for each turn from your scan's photos, like “Turn left at the purple mural.” Guests
          only see the ones you approve.
        </p>
      </div>

      {!revisionId ? (
        <p className="rounded-2xl bg-surface p-4 text-muted ring-1 ring-forest/10">
          Directions come from a processed phone scan. This map was uploaded as a file, so there's nothing to review.
        </p>
      ) : null}

      {revisionId && state.phase === "loading" ? (
        <p role="status" className="text-muted">
          Loading directions…
        </p>
      ) : null}

      {revisionId && state.phase === "error" ? (
        <div role="alert" className="grid gap-2 rounded-2xl bg-surface p-4 ring-1 ring-rust/30">
          <p>{state.message}</p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="min-h-11 justify-self-start rounded-full px-4 font-bold text-forest ring-2 ring-forest"
          >
            Try again
          </button>
        </div>
      ) : null}

      {revisionId && state.phase === "ready" && state.cues.length === 0 ? (
        <p className="rounded-2xl bg-surface p-4 text-muted ring-1 ring-forest/10">
          No directions yet. They appear here after the scan finishes processing.
        </p>
      ) : null}

      {revisionId && state.phase === "ready" && state.cues.length > 0 && counts ? (
        <>
          <p className="font-bold" aria-live="polite">
            {counts.waiting} waiting · {counts.approved} approved · {counts.rejected} rejected
          </p>
          <ol className="grid gap-4">
            {state.cues.map((cue, index) => (
              <li key={cue.id}>
                <CueCard cue={cue} number={index + 1} shareId={shareId} onSaved={replace} />
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}

function CueCard({
  cue,
  number,
  shareId,
  onSaved,
}: {
  cue: Cue;
  number: number;
  shareId: string;
  onSaved: (cue: Cue) => void;
}) {
  const fieldId = useId();
  const [text, setText] = useState(cue.instruction);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoFailed, setPhotoFailed] = useState(false);
  const cleaned = cleanInstruction(text);
  const edited = cleaned !== null && cleaned !== cue.instruction;
  const frameId = cue.sourceFrameIds[0];

  async function save(change: { instruction?: string; status?: "draft" | "approved" | "rejected" }, done: string) {
    setSaving(true);
    setError(null);
    try {
      const saved = await updateCue(cue.id, change);
      onSaved(saved);
      setText(saved.instruction);
      toast.success(done, { description: saved.instruction });
    } catch (e) {
      setError(e instanceof CueError ? e.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  function approve() {
    if (!cleaned) {
      setError(`Write a direction of 1 to ${MAX_INSTRUCTION_LENGTH} characters first.`);
      return;
    }
    void save(edited ? { instruction: cleaned, status: "approved" } : { status: "approved" }, "Direction approved");
  }

  return (
    <article
      aria-labelledby={`${fieldId}-title`}
      className="grid gap-3 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-forest/10"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${fieldId}-title`} className="font-display text-lg font-extrabold">
          Turn {number}
        </h3>
        <span className={`rounded-full px-3 py-1 text-sm font-bold ring-1 ${STATUS_STYLE[cue.status]}`}>
          {STATUS_LABEL[cue.status]}
        </span>
      </div>

      {frameId && !photoFailed ? (
        <img
          src={framePath(shareId, frameId)}
          alt={`Scan photo ${frameId} that Gemini used for turn ${number}`}
          loading="lazy"
          onError={() => setPhotoFailed(true)}
          className="aspect-[4/3] w-full rounded-xl bg-night object-cover"
        />
      ) : frameId ? (
        <p className="rounded-xl bg-paper px-3 py-2 text-sm text-muted">The photo for this turn isn't available.</p>
      ) : null}

      <p className="text-sm text-muted">
        {cue.landmark ? <>Landmark: <strong className="text-forest">{cue.landmark}</strong></> : "No landmark named"}
        {cue.confidence ? <> · {CONFIDENCE_LABEL[cue.confidence]}</> : null}
      </p>

      <label htmlFor={fieldId} className="grid gap-1">
        <span className="font-bold">What guests read</span>
        <textarea
          id={fieldId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          maxLength={MAX_INSTRUCTION_LENGTH + 20}
          disabled={saving}
          aria-describedby={error ? `${fieldId}-error` : undefined}
          aria-invalid={error ? true : undefined}
          className="rounded-lg bg-paper px-3 py-2 text-lg ring-1 ring-forest/25 focus:ring-2 focus:ring-forest focus:outline-none"
        />
      </label>
      {cue.status === "abstained" ? (
        <p className="text-sm text-muted">Gemini couldn't find a clear landmark. Type one you know is there, or reject it.</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {cue.status !== "approved" || edited ? (
          <button
            type="button"
            onClick={approve}
            disabled={saving}
            className="min-h-11 rounded-full bg-forest px-5 font-bold text-paper disabled:bg-forest/30 disabled:text-forest/70"
          >
            {edited ? "Save and approve" : "Approve"}
          </button>
        ) : null}
        {cue.status !== "rejected" ? (
          <button
            type="button"
            onClick={() => void save({ status: "rejected" }, "Direction rejected")}
            disabled={saving}
            className="min-h-11 rounded-full px-5 font-bold text-rust ring-2 ring-rust/60 disabled:opacity-50"
          >
            Reject
          </button>
        ) : null}
        {cue.status === "approved" || cue.status === "rejected" ? (
          <button
            type="button"
            onClick={() => void save({ status: "draft" }, "Moved back to review")}
            disabled={saving}
            className="min-h-11 rounded-full px-5 font-bold text-forest ring-2 ring-forest/40 disabled:opacity-50"
          >
            {cue.status === "approved" ? "Unapprove" : "Undo reject"}
          </button>
        ) : null}
      </div>
      {saving ? (
        <p role="status" className="text-sm text-muted">
          Saving…
        </p>
      ) : null}
      {error ? (
        <p id={`${fieldId}-error`} role="alert" className="text-rust">
          {error}
        </p>
      ) : null}
    </article>
  );
}
