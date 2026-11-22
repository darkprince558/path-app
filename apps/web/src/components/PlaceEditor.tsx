import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  CATEGORY_LABEL,
  cleanPlaceName,
  createPlace,
  deletePlace,
  fetchPlaces,
  MAX_PLACE_NAME_LENGTH,
  PLACE_CATEGORIES,
  PlaceError,
  sortPlaces,
  updatePlace,
  type Place,
  type PlaceCategory,
  type PlacePosition,
} from "../lib/places";
import { fetchAsset, fetchShare } from "../lib/shares";
import type { ModelPick, SpaceModel, ViewerPlace } from "./SpaceViewer";

const SpaceViewer = lazy(() => import("./SpaceViewer"));
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const PENDING = "pending-place";

type Load =
  | { phase: "loading" }
  | { phase: "ready"; models: SpaceModel[] }
  | { phase: "unsupported" }
  | { phase: "error"; message: string };

/**
 * Manage map → "Places on this map". The owner double-clicks the model to pin a named place
 * ("Room 2", "Washroom"), and can rename, re-type, move or remove it later. Sharing beyond
 * Private stays locked until there is at least one place (see ManageMap).
 */
export default function PlaceEditor({ mapId, shareId, onCountChange }: {
  mapId: string;
  shareId: string;
  onCountChange?: (count: number | null) => void;
}) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [fileWaypoints, setFileWaypoints] = useState<ViewerPlace[]>([]);
  const [placesError, setPlacesError] = useState<string | null>(null);
  const [pending, setPending] = useState<PlacePosition | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<PlaceCategory>("room");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: "loading" });
    (async () => {
      try {
        const meta = await fetchShare(shareId, controller.signal);
        if (meta.format !== "glb") return setLoad({ phase: "unsupported" });
        const bytes = await fetchAsset(meta.assetPath, controller.signal);
        setLoad({ phase: "ready", models: [{ id: meta.scanId ?? meta.shareId, name: meta.name, bytes, transform: meta.transform ?? IDENTITY }] });
      } catch (error) {
        if (!controller.signal.aborted) setLoad({ phase: "error", message: error instanceof Error ? error.message : "Couldn't open the model." });
      }
    })();
    fetchPlaces(shareId, controller.signal, true)
      .then((list) => { setPlaces(list); setPlacesError(null); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPlaces(null);
        setPlacesError(error instanceof PlaceError ? error.message : "Couldn't load the places.");
      });
    return () => controller.abort();
  }, [shareId]);

  useEffect(() => { onCountChange?.(places ? places.length : null); }, [places, onCountChange]);

  const viewerPlaces = useMemo<ViewerPlace[]>(() => {
    const shown: ViewerPlace[] = (places ?? []).map((place) => ({
      id: place.id, name: place.name, categoryLabel: CATEGORY_LABEL[place.category], local: place.position,
    }));
    if (pending) shown.push({ id: PENDING, name: cleanPlaceName(name) ?? "New place", categoryLabel: CATEGORY_LABEL[category], local: pending });
    return shown;
  }, [places, pending, name, category]);

  async function onPick(pick: ModelPick) {
    if (!places) return;
    if (moving) {
      const id = moving;
      setMoving(null);
      try {
        const moved = await updatePlace(id, { position: pick.localPoint });
        setPlaces((list) => sortPlaces((list ?? []).map((p) => (p.id === id ? moved : p))));
        toast.success("Place moved", { description: moved.name });
      } catch (error) {
        toast.error("Couldn't move the place", { description: error instanceof PlaceError ? error.message : undefined });
      }
      return;
    }
    setPending(pick.localPoint);
    setFormError(null);
    setSelected(PENDING);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!pending) return;
    const cleaned = cleanPlaceName(name);
    if (!cleaned) return setFormError(`Give the place a name of 1 to ${MAX_PLACE_NAME_LENGTH} characters.`);
    setBusy(true);
    setFormError(null);
    try {
      const place = await createPlace(mapId, { name: cleaned, category, position: pending });
      setPlaces((list) => sortPlaces([...(list ?? []), place]));
      setPending(null);
      setName("");
      setSelected(place.id);
      toast.success("Place added", { description: place.name });
    } catch (error) {
      setFormError(error instanceof PlaceError ? error.message : "Couldn't add the place.");
    } finally {
      setBusy(false);
    }
  }

  async function change(place: Place, update: { name?: string; category?: PlaceCategory }) {
    try {
      const saved = await updatePlace(place.id, update);
      setPlaces((list) => sortPlaces((list ?? []).map((p) => (p.id === place.id ? saved : p))));
    } catch (error) {
      toast.error("Couldn't save the change", { description: error instanceof PlaceError ? error.message : undefined });
    }
  }

  async function remove(place: Place) {
    try {
      await deletePlace(place.id);
      setPlaces((list) => (list ?? []).filter((p) => p.id !== place.id));
      toast.success("Place removed", { description: place.name });
    } catch (error) {
      toast.error("Couldn't remove the place", { description: error instanceof PlaceError ? error.message : undefined });
    }
  }

  return (
    <section id="places" aria-labelledby="places-title" className="grid gap-4">
      <div>
        <h2 id="places-title" className="font-display text-xl font-extrabold">Places on this map</h2>
        <p className="text-muted">
          Label rooms and key spots so first-time visitors know what is where. Double-click (or double-tap) the
          floor just in front of each room or door, then name it. Visitors see these labels on the 3D map and can
          tap one to route there.
        </p>
      </div>

      {load.phase === "loading" ? <p role="status" className="text-muted">Opening the model…</p> : null}
      {load.phase === "unsupported" ? (
        <p className="rounded-2xl bg-surface p-4 ring-1 ring-forest/10">
          Places can be pinned on GLB maps. This map is a point cloud (PLY), so it has no places.
        </p>
      ) : null}
      {load.phase === "error" ? <p role="alert" className="text-rust">Couldn't open the model: {load.message}</p> : null}
      {placesError ? <p role="alert" className="text-rust">{placesError}</p> : null}

      {load.phase === "ready" ? (
        <div className="h-[26rem] overflow-hidden rounded-2xl bg-night ring-1 ring-forest/20">
          <Suspense fallback={<p role="status" className="p-6 text-paper">Building the 3D view…</p>}>
            <SpaceViewer models={load.models} nodes={[]} edges={[]} onPick={(pick) => void onPick(pick)}
              places={viewerPlaces} onFileWaypoints={setFileWaypoints} highlightPlaceId={selected} onPlaceSelect={setSelected} />
          </Suspense>
        </div>
      ) : null}

      {moving ? (
        <p role="status" className="rounded-lg bg-amber-100 px-3 py-2 font-bold text-night">
          Double-click the new spot for “{places?.find((p) => p.id === moving)?.name}”.{" "}
          <button type="button" className="underline" onClick={() => setMoving(null)}>Cancel</button>
        </p>
      ) : null}

      {pending ? (
        <form onSubmit={(event) => void save(event)} className="grid gap-2 rounded-2xl bg-surface p-4 ring-1 ring-forest/20" noValidate>
          <p className="font-bold">New place at the spot you chose</p>
          <label htmlFor="place-name" className="text-sm font-bold">Name</label>
          <input id="place-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_PLACE_NAME_LENGTH + 20}
            placeholder="Room 2, Washroom, Main entrance…" aria-invalid={formError ? true : undefined}
            className="min-h-12 rounded-lg bg-paper px-3 ring-1 ring-forest/25 focus:ring-2 focus:ring-forest focus:outline-none" />
          <label htmlFor="place-category" className="text-sm font-bold">Type</label>
          <select id="place-category" value={category} onChange={(e) => setCategory(e.target.value as PlaceCategory)}
            className="min-h-12 rounded-lg bg-paper px-3 ring-1 ring-forest/25">
            {PLACE_CATEGORIES.map((value) => <option key={value} value={value}>{CATEGORY_LABEL[value]}</option>)}
          </select>
          {formError ? <p role="alert" className="text-rust">{formError}</p> : null}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="min-h-12 rounded-full bg-forest px-5 font-bold text-paper disabled:bg-forest/30">
              {busy ? "Saving…" : "Add place"}
            </button>
            <button type="button" onClick={() => { setPending(null); setFormError(null); }} className="min-h-12 rounded-full px-5 font-bold ring-2 ring-forest">
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {fileWaypoints.length > 0 && <details className="rounded-xl bg-surface p-3">
        <summary className="cursor-pointer font-bold">Waypoints in this scan · {fileWaypoints.length}</summary>
        <ul className="grid gap-1 pt-2 sm:grid-cols-2">
          {fileWaypoints.map(p => <li key={p.id}><button type="button" onClick={() => setSelected(p.id)}
            aria-pressed={selected === p.id} className="min-h-11 rounded-lg px-2 text-left underline">{p.name}</button></li>)}
        </ul>
      </details>}
      {places && places.length === 0 && fileWaypoints.length === 0 && !pending ? (
        <p className="rounded-2xl bg-amber-100 p-4 font-bold text-night ring-1 ring-amber-400">
          No places yet. Add a few (for example the entrance) so visitors know where things are.
        </p>
      ) : null}

      {places && places.length > 0 ? (
        <ul className="grid gap-2" aria-label="Places">
          {places.map((place) => (
            <PlaceRow key={place.id} place={place} selected={selected === place.id} onSelect={() => setSelected(place.id)}
              onRename={(value) => void change(place, { name: value })} onCategory={(value) => void change(place, { category: value })}
              onMove={() => { setMoving(place.id); setPending(null); }} onRemove={() => void remove(place)} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function PlaceRow({ place, selected, onSelect, onRename, onCategory, onMove, onRemove }: {
  place: Place; selected: boolean; onSelect: () => void; onRename: (name: string) => void;
  onCategory: (category: PlaceCategory) => void; onMove: () => void; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(place.name);
  const cleaned = cleanPlaceName(draft);
  return (
    <li className={`grid gap-2 rounded-xl bg-surface p-3 ring-1 ${selected ? "ring-2 ring-amber-400" : "ring-forest/15"}`}>
      {editing ? (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (cleaned) { onRename(cleaned); setEditing(false); } }}>
          <label htmlFor={`rename-${place.id}`} className="sr-only">New name for {place.name}</label>
          <input id={`rename-${place.id}`} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-lg bg-paper px-3 ring-1 ring-forest/25" />
          <button type="submit" disabled={!cleaned} className="min-h-11 rounded-full bg-forest px-4 font-bold text-paper disabled:bg-forest/30">Save</button>
          <button type="button" onClick={() => { setDraft(place.name); setEditing(false); }} className="min-h-11 px-2 underline">Cancel</button>
        </form>
      ) : (
        <button type="button" onClick={onSelect} className="text-left font-bold">{place.name}</button>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="sr-only" htmlFor={`category-${place.id}`}>Type of {place.name}</label>
        <select id={`category-${place.id}`} value={place.category} onChange={(e) => onCategory(e.target.value as PlaceCategory)}
          className="min-h-11 rounded-lg bg-paper px-2 ring-1 ring-forest/25">
          {PLACE_CATEGORIES.map((value) => <option key={value} value={value}>{CATEGORY_LABEL[value]}</option>)}
        </select>
        <button type="button" onClick={() => setEditing(true)} className="min-h-11 rounded-full px-3 font-bold ring-1 ring-forest/40">Rename</button>
        <button type="button" onClick={onMove} className="min-h-11 rounded-full px-3 font-bold ring-1 ring-forest/40">Move</button>
        <button type="button" onClick={onRemove} className="min-h-11 rounded-full px-3 font-bold text-rust ring-1 ring-rust/40">Remove</button>
      </div>
    </li>
  );
}
