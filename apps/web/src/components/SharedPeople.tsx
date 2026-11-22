import { useEffect, useState, type FormEvent } from "react";
import { addViewer, listViewers, removeViewer, UploadError, ViewersUnavailableError, type MapViewer } from "../lib/scans";

type Load = { state: "loading" } | { state: "ready" } | { state: "unavailable" } | { state: "error"; message: string };

/**
 * "Shared users" on Manage map: the owner adds people to a private map by the email they
 * sign in with, and removes them. Only the owner sees this list and its emails.
 */
export default function SharedPeople({ mapId, fallbackNames, onNamesChange }: {
  /** The ID edit calls take (mapEditId). */
  mapId: string;
  /** Names from the maps list, shown read-only when this server can't manage people. */
  fallbackNames: string[];
  onNamesChange?: (names: string[]) => void;
}) {
  const [people, setPeople] = useState<MapViewer[]>([]);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    listViewers(mapId).then(
      (viewers) => { if (!cancelled) { setPeople(viewers); setLoad({ state: "ready" }); } },
      (error) => {
        if (cancelled) return;
        if (error instanceof ViewersUnavailableError) setLoad({ state: "unavailable" });
        else setLoad({ state: "error", message: error instanceof UploadError ? error.message : "Couldn't load who can open this map." });
      },
    );
    return () => { cancelled = true; };
  }, [mapId]);

  function show(viewers: MapViewer[]) {
    setPeople(viewers);
    onNamesChange?.(viewers.map((viewer) => viewer.displayName));
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const value = email.trim();
    if (!value) return;
    setBusy("add");
    setMessage(null);
    try {
      const before = new Set(people.map((viewer) => viewer.id));
      const viewers = await addViewer(mapId, value);
      show(viewers);
      setEmail("");
      const added = viewers.filter((viewer) => !before.has(viewer.id));
      setMessage({ tone: "ok", text: added.length
        ? `Added ${added.map((viewer) => viewer.displayName).join(", ")}. They'll find it under Shared with me.`
        : `${value} already has access.` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof UploadError ? error.message : "Nobody was added." });
    } finally {
      setBusy(null);
    }
  }

  async function remove(viewer: MapViewer) {
    setBusy(viewer.id);
    setMessage(null);
    try {
      show(await removeViewer(mapId, viewer.id));
      setMessage({ tone: "ok", text: `Removed ${viewer.displayName}. They can no longer open this map.` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof UploadError ? error.message : "Their access didn't change." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="shared-users-title" className="grid gap-3 rounded-lg bg-surface px-4 py-3 ring-1 ring-forest/15">
      <h3 id="shared-users-title" className="font-bold">Shared users</h3>

      {load.state === "loading" ? <p role="status">Loading who can open it…</p> : null}
      {load.state === "error" ? <p role="alert" className="text-rust">{load.message}</p> : null}
      {load.state === "unavailable" ? (
        <>
          {fallbackNames.length ? (
            <ul className="flex flex-wrap gap-2">
              {fallbackNames.map((name) => (
                <li key={name} className="rounded-full bg-paper px-3 py-1 text-sm ring-1 ring-forest/20">{name}</li>
              ))}
            </ul>
          ) : <p>Just you.</p>}
          <p className="text-sm text-muted">This server can't add or remove people.</p>
        </>
      ) : null}

      {load.state === "ready" ? (
        <>
          {people.length ? (
            <ul aria-label="People who can open this map" className="grid gap-2">
              {people.map((viewer) => (
                <li key={viewer.id} className="flex items-center justify-between gap-3 rounded-lg bg-paper px-3 py-2 ring-1 ring-forest/15">
                  <span className="min-w-0">
                    <span className="block truncate font-bold">{viewer.displayName}</span>
                    {viewer.email ? <span className="block truncate text-sm text-muted">{viewer.email}</span> : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(viewer)}
                    disabled={busy !== null}
                    aria-label={`Remove ${viewer.displayName}`}
                    className="min-h-11 shrink-0 rounded-full px-4 text-sm font-bold text-rust ring-2 ring-rust/60 disabled:opacity-50"
                  >
                    {busy === viewer.id ? "Removing…" : "Remove"}
                  </button>
                </li>
              ))}
            </ul>
          ) : <p>Just you. Add someone by the email they sign in with.</p>}

          <form onSubmit={add} className="grid gap-2">
            <label htmlFor="shared-user-email" className="text-sm font-bold">Add by email</label>
            <div className="flex flex-wrap gap-2">
              <input
                id="shared-user-email"
                type="email"
                autoComplete="off"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={busy !== null}
                placeholder="name@example.com"
                className="min-h-12 min-w-0 flex-1 basis-48 rounded-lg bg-paper px-3 ring-1 ring-forest/25"
              />
              <button
                type="submit"
                disabled={busy !== null || !email.trim()}
                className="min-h-12 rounded-full bg-forest px-5 font-bold text-paper disabled:bg-forest/30 disabled:text-forest/70"
              >
                {busy === "add" ? "Adding…" : "Add"}
              </button>
            </div>
            <p className="text-sm text-muted">They need to have signed in to Not 404 at least once.</p>
          </form>
        </>
      ) : null}

      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-rust" : ""}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
