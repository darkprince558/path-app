import { ArrowLeft } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import ConfirmDialog from "../components/ConfirmDialog";
import CueReview from "../components/CueReview";
import PlaceEditor from "../components/PlaceEditor";
import SharePanel from "../components/SharePanel";
import { sharingLockReason } from "../lib/places";
import {
  cleanMapName,
  deleteMap,
  fetchMyMaps,
  ListUnavailableError,
  mapEditId,
  MAX_NAME_LENGTH,
  updateMap,
  UploadError,
  viewerNames,
  type OwnedMap,
} from "../lib/scans";

type State =
  | { phase: "loading" }
  | { phase: "ready"; map: OwnedMap }
  | { phase: "missing" }
  | { phase: "error"; message: string };

/** /maps/:shareId: rename, change sharing, copy link or QR, and delete one of your maps. */
export default function ManageMap() {
  const { shareId = "" } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });
    fetchMyMaps(controller.signal)
      .then((maps) => {
        const map = maps.find((m) => m.shareId === shareId);
        setState(map ? { phase: "ready", map } : { phase: "missing" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          phase: "error",
          message:
            error instanceof ListUnavailableError
              ? "This server can't manage maps yet."
              : error instanceof Error
                ? error.message
                : "Couldn't load this map.",
        });
      });
    return () => controller.abort();
  }, [shareId]);

  useEffect(() => {
    document.title = state.phase === "ready" ? `Manage ${state.map.name} · Not 404` : "Manage map · Not 404";
  }, [state]);

  return (
    <div className="mx-auto grid max-w-lg gap-8">
      <Link to="/maps" className="inline-flex items-center gap-1 justify-self-start text-sm font-bold text-rust underline underline-offset-4">
        <ArrowLeft className="size-4" aria-hidden />
        Your maps
      </Link>

      {state.phase === "loading" ? (
        <p role="status" className="text-muted">
          Loading the map…
        </p>
      ) : null}

      {state.phase === "missing" || state.phase === "error" ? (
        <div role="alert" className="rounded-2xl bg-surface p-5 ring-1 ring-rust/30">
          <h1 className="font-display text-2xl font-black">
            {state.phase === "missing" ? "This map isn't one of yours" : "Couldn't load this map"}
          </h1>
          <p className="mt-2 text-muted">
            {state.phase === "missing"
              ? "It may have been deleted, or it belongs to someone else. Only a map's owner can manage it."
              : state.message}
          </p>
        </div>
      ) : null}

      {state.phase === "ready" ? (
        <ManageReady
          map={state.map}
          onRenamed={(name) => setState({ phase: "ready", map: { ...state.map, name } })}
          onDeleted={() => navigate("/maps", { replace: true })}
        />
      ) : null}
    </div>
  );
}

function ManageReady({
  map,
  onRenamed,
  onDeleted,
}: {
  map: OwnedMap;
  onRenamed: (name: string) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(map.name);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Null until loaded (or when places aren't available for this map): sharing is not locked then.
  const [placeCount, setPlaceCount] = useState<number | null>(null);

  const cleaned = cleanMapName(name);
  const nameChanged = cleaned !== null && cleaned !== map.name;

  async function saveName(event: FormEvent) {
    event.preventDefault();
    if (!cleaned) {
      setNameError(`Give the map a name of 1 to ${MAX_NAME_LENGTH} characters.`);
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      const result = await updateMap(mapEditId(map), { name: cleaned });
      onRenamed(result.name);
      setName(result.name);
      toast.success("Name saved", { description: result.name });
    } catch (error) {
      setNameError(error instanceof UploadError ? error.message : "Couldn't save the name.");
    } finally {
      setSavingName(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await deleteMap(mapEditId(map));
      toast.success("Map deleted", { description: map.name });
      onDeleted();
    } catch (error) {
      toast.error("Couldn't delete the map", { description: error instanceof UploadError ? error.message : undefined });
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <>
      <div>
        <p className="text-sm font-bold text-muted">Manage map</p>
        <h1 className="font-display text-4xl leading-tight font-black break-words">{map.name}</h1>
      </div>

      <form onSubmit={saveName} className="grid gap-2" noValidate>
        <label htmlFor="map-name" className="font-display text-xl font-extrabold">
          Name
        </label>
        <p id="map-name-hint" className="text-sm text-muted">
          What people see on the map card and at the top of the map. Up to {MAX_NAME_LENGTH} characters.
        </p>
        <div className="flex gap-2">
          <input
            id="map-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LENGTH + 20}
            aria-describedby={nameError ? "map-name-hint map-name-error" : "map-name-hint"}
            aria-invalid={nameError ? true : undefined}
            className="min-h-12 min-w-0 flex-1 rounded-lg bg-surface px-3 ring-1 ring-forest/25 focus:ring-2 focus:ring-forest focus:outline-none"
          />
          <button
            type="submit"
            disabled={!nameChanged || savingName}
            className="min-h-12 shrink-0 rounded-full bg-forest px-5 font-bold text-paper disabled:bg-forest/30 disabled:text-forest/70"
          >
            {savingName ? "Saving…" : "Save"}
          </button>
        </div>
        {nameError ? (
          <p id="map-name-error" role="alert" className="text-rust">
            {nameError}
          </p>
        ) : null}
      </form>

      {map.format === "glb" ? <PlaceEditor mapId={mapEditId(map)} shareId={map.shareId} onCountChange={setPlaceCount} /> : null}

      <SharePanel
        mapId={mapEditId(map)}
        sharePath={map.sharePath}
        initialVisibility={map.visibility}
        viewers={viewerNames(map)}
        heading="Link and QR code"
        lockedReason={map.format === "glb" ? sharingLockReason(placeCount) : null}
      />

      <CueReview shareId={map.shareId} revisionId={map.revisionId} />

      <section aria-labelledby="delete-title" className="grid gap-2 rounded-2xl p-5 ring-2 ring-rust/40">
        <h2 id="delete-title" className="font-display text-xl font-extrabold">
          Delete this map
        </h2>
        <p className="text-muted">
          The scan and its link are removed for everyone, including people you shared it with. This can't be undone.
        </p>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-2 min-h-12 justify-self-start rounded-full bg-rust px-5 font-bold text-paper"
        >
          Delete map…
        </button>
      </section>

      <ConfirmDialog
        open={confirming}
        title={`Delete “${map.name}”?`}
        confirmLabel="Delete map"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirming(false)}
      >
        <p>Anyone with the link or QR code won't be able to open it anymore.</p>
        <p className="font-bold">This can't be undone.</p>
      </ConfirmDialog>
    </>
  );
}
