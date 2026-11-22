import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { request, send } from "./space-api";
import type { Visibility } from "./scans";

/*
 * Events: an organizer attaches maps, shares an invite link, and everyone who joins can
 * open exactly those maps (with directions), whatever each map's own visibility.
 *
 *   GET    /api/events/mine                    -> { events: MyEvent[] }
 *   POST   /api/events {name, description?}    -> EventDetail (private, with inviteCode)
 *   GET    /api/events/<id>                    -> EventDetail
 *   DELETE /api/events/<id>                    -> 204 (organizer)
 *   POST   /api/events/<id>/maps {scanId}      -> EventDetail (organizer, own maps)
 *   DELETE /api/events/<id>/maps/<scanId>      -> EventDetail (organizer)
 *   GET    /api/events/<id>/join?code=…        -> InvitePreview (works signed out)
 *   POST   /api/events/<id>/join {inviteCode}  -> { eventId, role }
 *   DELETE /api/events/<id>/join               -> 204 (leave)
 *   GET    /api/events/<id>/members            -> { members: EventMember[] } (organizer)
 *   DELETE /api/events/<id>/members/<userId>   -> 204 (organizer)
 */

export type EventRole = "organizer" | "member";

export interface MyEvent {
  id: string;
  name: string;
  description: string | null;
  role: EventRole;
  mapCount: number;
  memberCount: number;
}

export interface EventMap {
  /** Scan ID: only sent to the organizer, for removing the map. */
  id?: string;
  shareId: string;
  sharePath: string;
  name: string;
  visibility: Visibility;
  updatedAt: string;
}

export interface EventDetail {
  event: { id: string; name: string; description: string | null; ownerId: string; inviteCode?: string | null };
  role: EventRole | null;
  maps: EventMap[];
}

export interface InvitePreview {
  event: { id: string; name: string; description: string | null };
  organizer: string;
  mapCount: number;
  role: EventRole | null;
}

export interface EventMember { userId: string; displayName: string; role: string }

const path = (id: string) => `/api/events/${encodeURIComponent(id)}`;

export const fetchEvent = (id: string, signal?: AbortSignal) => request<EventDetail>(path(id), { signal });
export const createEvent = (input: { name: string; description?: string }) => send<EventDetail>("/api/events", "POST", input);
export const deleteEvent = (id: string) => request<null>(path(id), { method: "DELETE" });
export const addEventMap = (id: string, scanId: string) => send<EventDetail>(`${path(id)}/maps`, "POST", { scanId });
export const removeEventMap = (id: string, scanId: string) =>
  request<EventDetail>(`${path(id)}/maps/${encodeURIComponent(scanId)}`, { method: "DELETE" });
export const fetchInvite = (id: string, code: string, signal?: AbortSignal) =>
  request<InvitePreview>(`${path(id)}/join?code=${encodeURIComponent(code)}`, { signal });
export const joinEvent = (id: string, inviteCode: string) => send<{ eventId: string; role: EventRole }>(`${path(id)}/join`, "POST", { inviteCode });
export const leaveEvent = (id: string) => request<null>(`${path(id)}/join`, { method: "DELETE" });
export const fetchMembers = (id: string, signal?: AbortSignal) => request<{ members: EventMember[] }>(`${path(id)}/members`, { signal });
export const removeMember = (id: string, userId: string) =>
  request<null>(`${path(id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });

/** The link the organizer shares. Opening it shows the event and a Join button. */
export function inviteUrl(eventId: string, inviteCode: string): string {
  return `${window.location.origin}/events/${encodeURIComponent(eventId)}/join?code=${encodeURIComponent(inviteCode)}`;
}

type MyEventsState = { status: "idle" | "loading" | "ready" | "error"; events: MyEvent[]; reload: () => void };
const MyEventsContext = createContext<MyEventsState>({ status: "idle", events: [], reload: () => {} });

/** The signed-in account's events, shared by the sidebar and the Events page. */
export function MyEventsProvider({ children }: { children: ReactNode }) {
  const { status: auth, user } = useAuth();
  const [state, setState] = useState<Omit<MyEventsState, "reload">>({ status: "idle", events: [] });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (auth !== "authenticated") { setState({ status: "idle", events: [] }); return; }
    const controller = new AbortController();
    setState((current) => ({ ...current, status: "loading" }));
    request<{ events: MyEvent[] }>("/api/events/mine", { signal: controller.signal })
      // An older server without this route may answer something else: treat that as no events.
      .then((body) => setState({ status: "ready", events: Array.isArray(body?.events) ? body.events : [] }))
      .catch(() => { if (!controller.signal.aborted) setState({ status: "error", events: [] }); });
    return () => controller.abort();
  }, [auth, user?.id, attempt]);
  return <MyEventsContext.Provider value={{ ...state, reload }}>{children}</MyEventsContext.Provider>;
}

export function useMyEvents() {
  return useContext(MyEventsContext);
}
