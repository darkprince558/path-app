import { and, count, desc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import type { connectDatabase } from '../../db/client';
import { eventMaps, eventMembers, events, scans, users } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import { requireOwner } from '../auth/authorization';
import { ApiError, notFound } from './http';
import { eventResponse, readEvent } from './events';
import { canReadScan } from './scans';
import { uuid } from './validation';

type Db = ReturnType<typeof connectDatabase>['db'];
type Event = typeof events.$inferSelect;
export type EventRole = 'organizer' | 'member';

export const eventMapInput = z.object({ scanId: uuid }).strict();

async function roleIn(db: Db, user: AppUser | null, event: Event): Promise<EventRole | null> {
  if (!user) return null;
  if (event.ownerId === user.id) return 'organizer';
  const [member] = await db.select({ userId: eventMembers.userId }).from(eventMembers)
    .where(and(eq(eventMembers.eventId, event.id), eq(eventMembers.userId, user.id))).limit(1);
  return member ? 'member' : null;
}

/** GET /api/events/mine: events the user organizes or joined, newest first. */
export async function listMyEvents(db: Db, user: AppUser) {
  const joined = db.select({ eventId: eventMembers.eventId }).from(eventMembers).where(eq(eventMembers.userId, user.id));
  const rows = await db.select().from(events)
    .where(or(eq(events.ownerId, user.id), inArray(events.id, joined))).orderBy(desc(events.createdAt));
  if (!rows.length) return { events: [] };
  const ids = rows.map(event => event.id);
  const [mapCounts, memberCounts] = await Promise.all([
    db.select({ eventId: eventMaps.eventId, n: count() }).from(eventMaps).where(inArray(eventMaps.eventId, ids)).groupBy(eventMaps.eventId),
    db.select({ eventId: eventMembers.eventId, n: count() }).from(eventMembers).where(inArray(eventMembers.eventId, ids)).groupBy(eventMembers.eventId),
  ]);
  const tally = (list: { eventId: string; n: number }[], id: string) => list.find(row => row.eventId === id)?.n ?? 0;
  return { events: rows.map(event => ({
    id: event.id, name: event.name, description: event.description,
    role: (event.ownerId === user.id ? 'organizer' : 'member') as EventRole,
    mapCount: tally(mapCounts, event.id), memberCount: tally(memberCounts, event.id), createdAt: event.createdAt,
  })) };
}

/** Maps attached to the event that this user can open, as map-card summaries. */
async function eventMapSummaries(db: Db, user: AppUser | null, event: Event, role: EventRole | null) {
  const rows = await db.select({ scan: scans }).from(eventMaps).innerJoin(scans, eq(scans.id, eventMaps.scanId))
    .where(eq(eventMaps.eventId, event.id)).orderBy(desc(eventMaps.createdAt));
  const maps = [];
  for (const { scan } of rows) {
    if (!(await canReadScan(db, user, scan))) continue;
    maps.push({
      // The scan ID is what edit calls take; only the organizer (its owner) needs it.
      ...(role === 'organizer' ? { id: scan.id } : {}),
      shareId: scan.shareId, sharePath: `/s/${scan.shareId}`, name: scan.name, format: scan.format,
      visibility: scan.visibility, updatedAt: scan.updatedAt,
    });
  }
  return maps;
}

/** GET /api/events/:id: the event (invite code for the organizer only), its maps and the caller's role. */
export async function eventDetail(db: Db, user: AppUser | null, event: Event) {
  const role = await roleIn(db, user, event);
  return { ...(await eventResponse(db, user, event)), role, maps: await eventMapSummaries(db, user, event, role) };
}

/** POST /api/events/:id/maps: the organizer attaches one of their own maps. */
export async function addEventMap(db: Db, user: AppUser, eventId: string, input: z.infer<typeof eventMapInput>) {
  const event = await readEvent(db, user, uuid.parse(eventId));
  requireOwner(user, event.ownerId);
  const [scan] = await db.select().from(scans).where(eq(scans.id, input.scanId)).limit(1);
  // Someone else's map is reported as missing: attaching would re-share it.
  if (!scan || scan.ownerId !== user.id) throw new ApiError(404, 'NOT_FOUND', 'Map not found among your maps');
  await db.insert(eventMaps).values({ eventId: event.id, scanId: scan.id }).onConflictDoNothing();
  return eventDetail(db, user, event);
}

/** DELETE /api/events/:id/maps/:scanId: members lose access on their next request. */
export async function removeEventMap(db: Db, user: AppUser, eventId: string, scanId: string) {
  const event = await readEvent(db, user, uuid.parse(eventId));
  requireOwner(user, event.ownerId);
  await db.delete(eventMaps).where(and(eq(eventMaps.eventId, event.id), eq(eventMaps.scanId, uuid.parse(scanId))));
  return eventDetail(db, user, event);
}

/**
 * GET /api/events/:id/join?code=…: what an invite link opens, before joining. A wrong
 * code or a public event answers 404 like a missing event, so codes can't be probed.
 */
export async function invitePreview(db: Db, user: AppUser | null, eventId: string, code: string | null) {
  const [row] = await db.select({ event: events, organizer: users.displayName }).from(events)
    .innerJoin(users, eq(users.id, events.ownerId)).where(eq(events.id, uuid.parse(eventId))).limit(1);
  if (!row || !code || row.event.visibility !== 'private' || row.event.inviteCode !== code) throw notFound();
  const [maps] = await db.select({ n: count() }).from(eventMaps).where(eq(eventMaps.eventId, row.event.id));
  return { event: { id: row.event.id, name: row.event.name, description: row.event.description },
    organizer: row.organizer, mapCount: maps?.n ?? 0, role: await roleIn(db, user, row.event) };
}

/** GET /api/events/:id/members (organizer only), with names to show. */
export async function listEventMembers(db: Db, user: AppUser, eventId: string) {
  const event = await readEvent(db, user, uuid.parse(eventId));
  requireOwner(user, event.ownerId);
  const members = await db.select({ eventId: eventMembers.eventId, userId: eventMembers.userId, role: eventMembers.role,
    displayName: users.displayName }).from(eventMembers).innerJoin(users, eq(users.id, eventMembers.userId))
    .where(eq(eventMembers.eventId, event.id)).orderBy(users.displayName);
  return { members };
}
