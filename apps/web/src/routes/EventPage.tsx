import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import ConfirmDialog from "../components/ConfirmDialog";
import MapCard from "../components/MapCard";
import { useAuth } from "../lib/auth";
import {
  addEventMap, deleteEvent, fetchEvent, fetchMembers, inviteUrl, leaveEvent, removeEventMap, removeMember,
  useMyEvents, type EventDetail, type EventMember,
} from "../lib/events";
import { loginHref } from "../lib/http";
import type { MapSummary } from "../lib/maps";
import { fetchMyMaps, type OwnedMap } from "../lib/scans";
import { ApiError } from "../lib/space-api";

type State = { phase: "loading" } | { phase: "ready"; detail: EventDetail } | { phase: "missing" } | { phase: "error"; message: string };

const errorText = (error: unknown, fallback: string) => (error instanceof Error ? `${fallback} ${error.message}` : fallback);

/** /events/:eventId: the event's maps for everyone in it; invite, maps and members for the organizer. */
export default function EventPage() {
  const { eventId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { status: auth } = useAuth();
  const { reload: reloadMyEvents } = useMyEvents();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [confirm, setConfirm] = useState<"delete" | "leave" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });
    fetchEvent(eventId, controller.signal)
      .then((detail) => { setState({ phase: "ready", detail }); document.title = `${detail.event.name} · Not 404`; })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 400)) setState({ phase: "missing" });
        else setState({ phase: "error", message: errorText(error, "Couldn't open this event.") });
      });
    return () => controller.abort();
  }, [eventId, auth]);

  const setDetail = useCallback((detail: EventDetail) => setState({ phase: "ready", detail }), []);

  async function confirmed() {
    if (state.phase !== "ready" || !confirm) return;
    setBusy(true);
    try {
      if (confirm === "delete") await deleteEvent(eventId);
      else await leaveEvent(eventId);
      toast.success(confirm === "delete" ? "Event deleted" : `You left ${state.detail.event.name}`);
      reloadMyEvents();
      navigate("/events");
    } catch (error) {
      toast.error(errorText(error, confirm === "delete" ? "Couldn't delete the event." : "Couldn't leave the event."));
      setBusy(false);
      setConfirm(null);
    }
  }

  if (state.phase === "loading") return <p role="status">Opening event…</p>;
  if (state.phase === "error") return <p role="alert" className="text-rust">{state.message}</p>;
  if (state.phase === "missing") {
    return (
      <div role="alert" className="mx-auto max-w-lg rounded-2xl bg-surface p-6 ring-1 ring-rust/30">
        <h1 className="font-display text-2xl font-black">Event not available</h1>
        {auth === "authenticated" ? (
          <p className="mt-2 text-muted">It doesn't exist, or you haven't joined it. Ask the organizer for an invite link.</p>
        ) : (
          <>
            <p className="mt-2 text-muted">Sign in to see events you've joined.</p>
            <a href={loginHref(location.pathname)} className="mt-4 inline-flex min-h-11 items-center rounded-full bg-coral px-5 font-bold text-ink">Sign in</a>
          </>
        )}
      </div>
    );
  }

  const { detail } = state;
  const organizer = detail.role === "organizer";
  const origin = { path: `/events/${eventId}`, label: detail.event.name };
  const cards: MapSummary[] = detail.maps.map((map) => ({
    id: map.shareId, name: map.name, visibility: map.visibility, sharePath: map.sharePath, updated: map.updatedAt,
  }));

  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/events" className="text-sm font-bold text-rust underline underline-offset-4">← Events</Link>
      <h1 className="mt-4 font-display text-4xl leading-none font-black">{detail.event.name}</h1>
      <p className="mt-2 font-bold text-forest">{organizer ? "You organize this event" : detail.role === "member" ? "You joined this event" : "Public event"}</p>
      {detail.event.description ? <p className="mt-3 max-w-2xl text-lg text-muted">{detail.event.description}</p> : null}

      <section aria-labelledby="event-maps-title" className="mt-8">
        <h2 id="event-maps-title" className="font-display text-2xl font-extrabold">Maps</h2>
        {cards.length ? (
          <ul className="mt-4 grid grid-cols-2 gap-3 xl-text:max-sm:grid-cols-1 sm:grid-cols-3 md:gap-5 xl:grid-cols-4">
            {cards.map((map) => <li key={map.id}><MapCard map={map} origin={origin} /></li>)}
          </ul>
        ) : (
          <p className="mt-2 text-muted">{organizer ? "No maps yet. Add some below, then share the invite link." : "The organizer hasn't added any maps yet."}</p>
        )}
      </section>

      {organizer ? (
        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          {detail.event.inviteCode ? <InvitePanel eventId={eventId} code={detail.event.inviteCode} /> : null}
          <ManageMaps eventId={eventId} detail={detail} onChange={setDetail} />
          <Members eventId={eventId} />
        </div>
      ) : null}

      <div className="mt-10">
        {organizer ? (
          <button type="button" onClick={() => setConfirm("delete")} className="min-h-11 rounded-full px-5 font-bold text-rust ring-2 ring-rust/60">Delete event</button>
        ) : detail.role === "member" ? (
          <button type="button" onClick={() => setConfirm("leave")} className="min-h-11 rounded-full px-5 font-bold text-rust ring-2 ring-rust/60">Leave event</button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "delete" ? `Delete ${detail.event.name}?` : `Leave ${detail.event.name}?`}
        confirmLabel={confirm === "delete" ? "Delete event" : "Leave event"}
        busy={busy}
        onConfirm={confirmed}
        onCancel={() => setConfirm(null)}
      >
        {confirm === "delete"
          ? "Everyone in it loses access to its maps. Your maps themselves stay in My maps. This can't be undone."
          : "You'll lose access to its private maps until someone sends you the invite link again."}
      </ConfirmDialog>
    </div>
  );
}

function InvitePanel({ eventId, code }: { eventId: string; code: string }) {
  const url = inviteUrl(eventId, code);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); }
    catch { input.current?.select(); toast.error("Couldn't copy automatically. The link is selected, so copy it from there."); }
  }
  return (
    <section aria-labelledby="invite-title" className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-forest/10">
      <h2 id="invite-title" className="font-display text-xl font-extrabold">Invite people</h2>
      <p className="mt-1 text-muted">Anyone with this link can join after signing in, then open every map in this event.</p>
      <label htmlFor="invite-url" className="sr-only">Invite link</label>
      <input id="invite-url" ref={input} readOnly value={url} onFocus={(e) => e.currentTarget.select()}
        className="mt-4 w-full truncate rounded-lg bg-paper px-3 py-3 font-mono text-sm text-forest ring-1 ring-forest/15" />
      <button type="button" onClick={copy} className="mt-3 min-h-12 w-full rounded-full bg-forest px-4 font-bold text-paper">
        {copied ? "Copied!" : "Copy invite link"}
      </button>
      <span aria-live="polite" className="sr-only">{copied ? "Invite link copied" : ""}</span>
      <figure className="mt-5 flex flex-col items-center gap-2">
        <div className="rounded-xl bg-surface p-3 ring-1 ring-forest/15">
          <QRCodeSVG value={url} size={180} fgColor="#2F4A3A" bgColor="#FAF5E6" level="M" marginSize={2} title={`QR code for the invite link`} />
        </div>
        <figcaption className="text-center text-sm text-muted">Show this on a screen or print it at the entrance.</figcaption>
      </figure>
    </section>
  );
}

function ManageMaps({ eventId, detail, onChange }: { eventId: string; detail: EventDetail; onChange: (detail: EventDetail) => void }) {
  const [mine, setMine] = useState<OwnedMap[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchMyMaps(controller.signal).then(setMine).catch((error) => {
      if (!controller.signal.aborted) setLoadError(errorText(error, "Couldn't load your maps."));
    });
    return () => controller.abort();
  }, []);
  const attached = useMemo(() => new Set(detail.maps.map((map) => map.shareId)), [detail.maps]);
  const available = (mine ?? []).filter((map) => map.id && !attached.has(map.shareId));

  async function run(key: string, action: () => Promise<EventDetail>, done: string) {
    setBusy(key);
    try { onChange(await action()); toast.success(done); setChoice(""); }
    catch (error) { toast.error(errorText(error, "That didn't work.")); }
    finally { setBusy(null); }
  }

  return (
    <section aria-labelledby="manage-maps-title" className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-forest/10">
      <h2 id="manage-maps-title" className="font-display text-xl font-extrabold">Maps in this event</h2>
      <p className="mt-1 text-muted">People in the event can open these even if they're Private.</p>
      {detail.maps.length ? (
        <ul aria-label="Maps in this event" className="mt-4 grid gap-2">
          {detail.maps.map((map) => (
            <li key={map.shareId} className="flex items-center justify-between gap-3 rounded-lg bg-paper px-3 py-2 ring-1 ring-forest/15">
              <span className="min-w-0 truncate font-bold">{map.name}</span>
              {map.id ? (
                <button type="button" disabled={busy !== null} aria-label={`Remove ${map.name} from the event`}
                  onClick={() => run(map.shareId, () => removeEventMap(eventId, map.id!), `Removed ${map.name}`)}
                  className="min-h-11 shrink-0 rounded-full px-4 text-sm font-bold text-rust ring-2 ring-rust/60 disabled:opacity-50">
                  {busy === map.shareId ? "Removing…" : "Remove"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <form className="mt-4 grid gap-2" onSubmit={(e) => {
        e.preventDefault();
        const map = available.find((m) => m.id === choice);
        if (map?.id) void run("add", () => addEventMap(eventId, map.id!), `Added ${map.name}`);
      }}>
        <label htmlFor="add-map" className="text-sm font-bold">Add one of your maps</label>
        {loadError ? <p role="alert" className="text-rust">{loadError}</p> : mine === null ? <p role="status">Loading your maps…</p> : available.length ? (
          <div className="flex flex-wrap gap-2">
            <select id="add-map" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy !== null}
              className="min-h-12 min-w-0 flex-1 basis-48 rounded-lg bg-paper px-3 ring-1 ring-forest/25">
              <option value="">Choose a map…</option>
              {available.map((map) => <option key={map.id} value={map.id}>{map.name}</option>)}
            </select>
            <button type="submit" disabled={!choice || busy !== null}
              className="min-h-12 rounded-full bg-forest px-5 font-bold text-paper disabled:bg-forest/30 disabled:text-forest/70">
              {busy === "add" ? "Adding…" : "Add"}
            </button>
          </div>
        ) : (
          <p className="text-muted">{mine.length ? "All your maps are in this event." : <>You have no maps yet. <Link to="/maps/new" className="font-bold text-rust underline">Upload one</Link>.</>}</p>
        )}
      </form>
    </section>
  );
}

function Members({ eventId }: { eventId: string }) {
  const [members, setMembers] = useState<EventMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchMembers(eventId, controller.signal).then((body) => setMembers(body.members)).catch((cause) => {
      if (!controller.signal.aborted) setError(errorText(cause, "Couldn't load members."));
    });
    return () => controller.abort();
  }, [eventId]);
  async function remove(member: EventMember) {
    setBusy(member.userId);
    try {
      await removeMember(eventId, member.userId);
      setMembers((list) => list?.filter((m) => m.userId !== member.userId) ?? null);
      toast.success(`Removed ${member.displayName}`);
    } catch (cause) { toast.error(errorText(cause, "Couldn't remove them.")); }
    finally { setBusy(null); }
  }
  return (
    <section aria-labelledby="members-title" className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-forest/10 lg:col-span-2">
      <h2 id="members-title" className="font-display text-xl font-extrabold">
        Members{members ? <span className="font-sans text-base font-bold text-muted"> · {members.length}</span> : null}
      </h2>
      {error ? <p role="alert" className="mt-2 text-rust">{error}</p> : members === null ? <p role="status" className="mt-2">Loading members…</p>
        : members.length === 0 ? <p className="mt-2 text-muted">Nobody has joined yet. Share the invite link.</p> : (
        <ul aria-label="Event members" className="mt-4 grid gap-2 sm:grid-cols-2">
          {members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between gap-3 rounded-lg bg-paper px-3 py-2 ring-1 ring-forest/15">
              <span className="min-w-0 truncate font-bold">{member.displayName}</span>
              <button type="button" disabled={busy !== null} aria-label={`Remove ${member.displayName}`} onClick={() => remove(member)}
                className="min-h-11 shrink-0 rounded-full px-4 text-sm font-bold text-rust ring-2 ring-rust/60 disabled:opacity-50">
                {busy === member.userId ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
