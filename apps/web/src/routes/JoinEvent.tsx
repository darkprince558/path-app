import { CalendarDays } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useAuth } from "../lib/auth";
import { fetchInvite, joinEvent, useMyEvents, type InvitePreview } from "../lib/events";
import { loginHref } from "../lib/http";
import { ApiError } from "../lib/space-api";

type State = { phase: "loading" } | { phase: "ready"; invite: InvitePreview } | { phase: "invalid" } | { phase: "error"; message: string };

/** /events/:eventId/join?code=…: what an invite link opens. Signed-out visitors sign in first. */
export default function JoinEvent() {
  const { eventId = "" } = useParams();
  const [search] = useSearchParams();
  const code = search.get("code") ?? "";
  const location = useLocation();
  const navigate = useNavigate();
  const { status: auth } = useAuth();
  const { reload } = useMyEvents();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) { setState({ phase: "invalid" }); return; }
    const controller = new AbortController();
    setState({ phase: "loading" });
    fetchInvite(eventId, code, controller.signal)
      .then((invite) => { setState({ phase: "ready", invite }); document.title = `Join ${invite.event.name} · Not 404`; })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 400)) setState({ phase: "invalid" });
        else setState({ phase: "error", message: error instanceof Error ? error.message : "Couldn't open this invite." });
      });
    return () => controller.abort();
  }, [eventId, code, auth]);

  async function join() {
    setJoining(true);
    setJoinError(null);
    try {
      await joinEvent(eventId, code);
      reload();
      navigate(`/events/${eventId}`, { replace: true });
    } catch (error) {
      setJoinError(error instanceof Error ? `Couldn't join. ${error.message}` : "Couldn't join.");
      setJoining(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      {state.phase === "loading" ? <p role="status">Opening invite…</p> : null}
      {state.phase === "invalid" ? (
        <div role="alert" className="rounded-2xl bg-surface p-6 ring-1 ring-rust/30">
          <h1 className="font-display text-2xl font-black">This invite link doesn't work</h1>
          <p className="mt-2 text-muted">It may be incomplete, or the organizer deleted the event. Ask them to send the link again.</p>
        </div>
      ) : null}
      {state.phase === "error" ? <p role="alert" className="text-rust">{state.message}</p> : null}
      {state.phase === "ready" ? (
        <section aria-labelledby="invite-title" className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-forest/10">
          <CalendarDays className="size-10 text-forest" aria-hidden />
          <p className="mt-4 text-muted">{state.invite.organizer} invited you to</p>
          <h1 id="invite-title" className="font-display text-4xl leading-none font-black">{state.invite.event.name}</h1>
          {state.invite.event.description ? <p className="mt-3">{state.invite.event.description}</p> : null}
          <p className="mt-3 text-muted">
            {state.invite.mapCount === 1 ? "1 map" : `${state.invite.mapCount} maps`} with directions, for everyone who joins.
          </p>
          <div className="mt-6">
            {state.invite.role ? (
              <Link to={`/events/${eventId}`} className="flex min-h-14 items-center justify-center rounded-full bg-coral px-6 text-lg font-bold text-ink">
                You're in. Open the event
              </Link>
            ) : auth === "authenticated" ? (
              <button type="button" onClick={join} disabled={joining}
                className="min-h-14 w-full rounded-full bg-coral px-6 text-lg font-bold text-ink disabled:bg-forest/15 disabled:text-forest/60">
                {joining ? "Joining…" : "Join event"}
              </button>
            ) : auth === "loading" ? (
              <p role="status">Checking sign-in…</p>
            ) : (
              <>
                <a href={loginHref(location.pathname + location.search)} className="flex min-h-14 items-center justify-center rounded-full bg-coral px-6 text-lg font-bold text-ink">
                  Sign in to join
                </a>
                <p className="mt-2 text-center text-sm text-muted">You'll come back here after signing in.</p>
              </>
            )}
            {joinError ? <p role="alert" className="mt-3 text-rust">{joinError}</p> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
