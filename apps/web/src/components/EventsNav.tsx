import { CalendarDays, ChevronDown, Plus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { useAuth } from "../lib/auth";
import { useMyEvents } from "../lib/events";

const ROW = "flex min-h-11 items-center gap-3 rounded-lg px-3 font-bold transition-colors";
const SUB_ROW = "flex min-h-10 items-center gap-2 rounded-lg py-1 pr-3 pl-11 text-sm font-bold transition-colors";
const tone = (active: boolean) => (active ? "bg-paper/12 text-paper" : "text-sage hover:bg-paper/6 hover:text-paper");

/**
 * Sidebar "Events" dropdown: Create event first, then the events you organize or joined.
 * Starts open on an event page and remembers the choice for this visit.
 */
export default function EventsNav() {
  const { pathname } = useLocation();
  const { status: auth } = useAuth();
  const { status, events } = useMyEvents();
  const onEvents = pathname.startsWith("/events");
  const [open, setOpen] = useState(onEvents);
  const listId = useId();
  useEffect(() => { if (onEvents) setOpen(true); }, [onEvents]);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className={`${ROW} w-full ${tone(onEvents && !open)}`}
      >
        <CalendarDays className="size-5" aria-hidden />
        <span className="flex-1 text-left">Events</span>
        <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      <ul id={listId} hidden={!open} aria-label="Events" className="mt-1 grid gap-0.5">
        <li>
          <NavLink to="/events/new" end className={({ isActive }) => `${SUB_ROW} pl-3 ${tone(isActive)}`}>
            <Plus className="ml-0.5 size-5" aria-hidden />
            <span className="ml-1">Create event</span>
          </NavLink>
        </li>
        {auth !== "authenticated" ? (
          <li className="py-1 pl-11 text-sm text-sage">Sign in to see your events.</li>
        ) : status === "loading" && !events.length ? (
          <li role="status" className="py-1 pl-11 text-sm text-sage">Loading…</li>
        ) : status === "error" ? (
          <li className="py-1 pl-11 text-sm text-sage">Couldn't load events.</li>
        ) : events.length === 0 ? (
          <li className="py-1 pl-11 text-sm text-sage">No events yet.</li>
        ) : (
          events.map((event) => (
            <li key={event.id}>
              <NavLink to={`/events/${event.id}`} className={({ isActive }) => `${SUB_ROW} ${tone(isActive)}`}>
                <span className="truncate">{event.name}</span>
              </NavLink>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
