import { and, eq, inArray } from 'drizzle-orm';
import type { connectDatabase } from '../../db/client';
import { destinations, eventDestinations, eventMembers, eventPaths, eventSpaces, events, paths, spaces } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import { badRequest, notFound } from './http';

type Db = ReturnType<typeof connectDatabase>['db'];
type Event = typeof events.$inferSelect;
type Links = { spaceIds: string[]; pathIds: string[]; destinationIds: string[] };

export async function canReadEvent(db: Db, user: AppUser | null, event: Event) {
  if (event.visibility === 'public' || event.ownerId === user?.id) return true;
  if (!user) return false;
  const [member] = await db.select({ userId: eventMembers.userId }).from(eventMembers)
    .where(and(eq(eventMembers.eventId, event.id), eq(eventMembers.userId, user.id))).limit(1);
  return !!member;
}

export async function readEvent(db: Db, user: AppUser | null, id: string) {
  const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  if (!event || !(await canReadEvent(db, user, event))) throw notFound();
  return event;
}

export async function validateEventLinks(db: Db, ownerId: string, eventVisibility: string, links: Links) {
  if (new Set(links.spaceIds).size !== links.spaceIds.length || new Set(links.pathIds).size !== links.pathIds.length ||
      new Set(links.destinationIds).size !== links.destinationIds.length) throw badRequest('Duplicate resource IDs are not allowed');
  const selectedSpaces = links.spaceIds.length ? await db.select().from(spaces).where(inArray(spaces.id, links.spaceIds)) : [];
  const selectedPaths = links.pathIds.length ? await db.select().from(paths).where(inArray(paths.id, links.pathIds)) : [];
  const selectedDestinations = links.destinationIds.length ? await db.select().from(destinations).where(inArray(destinations.id, links.destinationIds)) : [];
  if (selectedSpaces.length !== links.spaceIds.length || selectedPaths.length !== links.pathIds.length ||
      selectedDestinations.length !== links.destinationIds.length) throw badRequest('An event resource does not exist');
  const spaceById = new Map(selectedSpaces.map(s => [s.id, s]));
  if (selectedSpaces.some(s => s.visibility !== 'public' && s.ownerId !== ownerId)) {
    throw badRequest('Private spaces must be owned by the event organizer');
  }
  if (eventVisibility === 'public' && selectedSpaces.some(s => s.visibility !== 'public')) {
    throw badRequest('Public events may contain only public spaces');
  }
  for (const path of selectedPaths) {
    const space = spaceById.get(path.spaceId);
    if (!space) throw badRequest('Every event path needs its space in the event');
    if (path.visibility !== 'public' && path.ownerId !== ownerId) throw badRequest('Private paths must be owned by the event organizer');
    if (eventVisibility === 'public' && (path.visibility !== 'public' || space.visibility !== 'public')) {
      throw badRequest('Public events may contain only public paths in public spaces');
    }
  }
  for (const destination of selectedDestinations) {
    if (!spaceById.has(destination.spaceId)) throw badRequest('Every event destination needs its space in the event');
  }
}

export async function eventLinks(db: Db, eventId: string): Promise<Links> {
  const [ss, ps, ds] = await Promise.all([
    db.select({ id: eventSpaces.spaceId }).from(eventSpaces).where(eq(eventSpaces.eventId, eventId)),
    db.select({ id: eventPaths.pathId }).from(eventPaths).where(eq(eventPaths.eventId, eventId)),
    db.select({ id: eventDestinations.destinationId }).from(eventDestinations).where(eq(eventDestinations.eventId, eventId)),
  ]);
  return { spaceIds: ss.map(x => x.id), pathIds: ps.map(x => x.id), destinationIds: ds.map(x => x.id) };
}

export async function eventResponse(db: Db, user: AppUser | null, event: Event) {
  const links = await eventLinks(db, event.id);
  const [selectedSpaces, selectedPaths, selectedDestinations] = await Promise.all([
    links.spaceIds.length ? db.select().from(spaces).where(inArray(spaces.id, links.spaceIds)) : [],
    links.pathIds.length ? db.select().from(paths).where(inArray(paths.id, links.pathIds)) : [],
    links.destinationIds.length ? db.select().from(destinations).where(inArray(destinations.id, links.destinationIds)) : [],
  ]);
  // Recheck current visibility: a later resource edit must not expose private data.
  const visibleSpaces = selectedSpaces.filter(s => s.visibility === 'public' || (event.visibility === 'private' && event.ownerId === s.ownerId && !!user));
  const visibleSpaceIds = new Set(visibleSpaces.map(s => s.id));
  const visiblePaths = selectedPaths.filter(p => visibleSpaceIds.has(p.spaceId) &&
    (p.visibility === 'public' || (event.visibility === 'private' && p.ownerId === event.ownerId && !!user)));
  const visibleDestinations = selectedDestinations.filter(d => visibleSpaceIds.has(d.spaceId));
  const { inviteCode, ...publicEvent } = event;
  return { event: event.ownerId === user?.id ? event : publicEvent, spaces: visibleSpaces,
    paths: visiblePaths, destinations: visibleDestinations };
}

export async function replaceEventLinks(tx: Parameters<Parameters<Db['transaction']>[0]>[0], eventId: string, links: Links) {
  await tx.delete(eventPaths).where(eq(eventPaths.eventId, eventId));
  await tx.delete(eventDestinations).where(eq(eventDestinations.eventId, eventId));
  await tx.delete(eventSpaces).where(eq(eventSpaces.eventId, eventId));
  if (links.spaceIds.length) await tx.insert(eventSpaces).values(links.spaceIds.map(spaceId => ({ eventId, spaceId })));
  if (links.pathIds.length) await tx.insert(eventPaths).values(links.pathIds.map(pathId => ({ eventId, pathId })));
  if (links.destinationIds.length) await tx.insert(eventDestinations).values(links.destinationIds.map(destinationId => ({ eventId, destinationId })));
}
