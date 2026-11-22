import { CalendarDays, Plus } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router";
import { useMyEvents } from "../lib/events";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** /events: events you organize or joined. On phones this is the Events tab. */
export default function Events() {
  const { status, events, reload } = useMyEvents();
  useEffect(() => { document.title = "Events · Not 404"; }, []);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl leading-none font-black">Events</h1>
          <p className="mt-3 text-lg text-muted">Share a set of maps with everyone you invite.</p>
        </div>
        <Link to="/events/new" className="flex min-h-12 items-center gap-2 rounded-full bg-coral px-5 font-bold text-ink">
          <Plus className="size-5" aria-hidden />
          Create event
        </Link>
      </div>

      {status === "loading" && !events.length ? <p role="status" className="mt-8">Loading your events…</p> : null}
      {status === "error" ? (
        <div role="alert" className="mt-8 rounded-2xl bg-surface p-5 ring-1 ring-rust/30">
          <p className="font-bold">Couldn't load your events</p>
          <button type="button" onClick={reload} className="mt-3 min-h-11 rounded-full bg-coral px-5 font-bold text-ink">Try again</button>
        </div>
      ) : null}
      {status === "ready" && events.length === 0 ? (
        <div className="mt-8 rounded-2xl bg-surface p-6 ring-1 ring-forest/10">
          <p className="font-bold">No events yet</p>
          <p className="mt-1 text-muted">Create one and add your maps, or open an invite link someone sent you.</p>
        </div>
      ) : null}

      {events.length ? (
        <ul className="mt-8 grid gap-3">
          {events.map((event) => (
            <li key={event.id}>
              <Link to={`/events/${event.id}`} className="flex items-center gap-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-forest/10 hover:ring-forest/30">
                <CalendarDays className="size-8 shrink-0 text-forest" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-xl font-extrabold">{event.name}</span>
                  <span className="block text-sm text-muted">
                    {event.role === "organizer" ? "You organize this" : "Joined"} · {plural(event.mapCount, "map")} · {plural(event.memberCount, "member")}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
