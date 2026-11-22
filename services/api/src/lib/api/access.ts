import { and, eq, inArray, or } from 'drizzle-orm';
import type { connectDatabase } from '../../db/client';
import { eventMembers, eventPaths, eventSpaces, events, paths, spaces } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import { notFound } from './http';

type Db = ReturnType<typeof connectDatabase>['db'];
type Space = typeof spaces.$inferSelect;
type Path = typeof paths.$inferSelect;

export async function canReadSpace(db: Db, user: AppUser | null, space: Space) {
  if (space.visibility === 'public' || space.visibility === 'unlisted' || space.ownerId === user?.id) return true;
  if (!user) return false;
  const [grant] = await db.select({ id: eventSpaces.eventId }).from(eventSpaces)
    .innerJoin(events, and(eq(events.id, eventSpaces.eventId), eq(events.ownerId, space.ownerId)))
    .innerJoin(eventMembers, and(eq(eventMembers.eventId, events.id), eq(eventMembers.userId, user.id)))
    .where(and(eq(eventSpaces.spaceId, space.id), eq(events.visibility, 'private'))).limit(1);
  return !!grant;
}

export async function readSpace(db: Db, user: AppUser | null, id: string) {
  const [space] = await db.select().from(spaces).where(eq(spaces.id, id)).limit(1);
  if (!space || !(await canReadSpace(db, user, space))) throw notFound();
  return space;
}

export async function listSpaces(db: Db, user: AppUser | null) {
  let grantedIds: string[] = [];
  if (user) {
    const grants = await db.select({ spaceId: eventSpaces.spaceId }).from(eventSpaces)
      .innerJoin(events, eq(events.id, eventSpaces.eventId))
      .innerJoin(eventMembers, and(eq(eventMembers.eventId, events.id), eq(eventMembers.userId, user.id)))
      .innerJoin(spaces, and(eq(spaces.id, eventSpaces.spaceId), eq(spaces.ownerId, events.ownerId)))
      .where(eq(events.visibility, 'private'));
    grantedIds = grants.map(g => g.spaceId);
  }
  const conditions = [eq(spaces.visibility, 'public')];
  if (user) conditions.push(eq(spaces.ownerId, user.id));
  if (grantedIds.length) conditions.push(inArray(spaces.id, grantedIds));
  return db.select().from(spaces).where(or(...conditions));
}

export async function canReadPath(db: Db, user: AppUser | null, path: Path, space: Space) {
  if (path.ownerId === user?.id) return canReadSpace(db, user, space);
  if (path.visibility === 'public' && space.visibility === 'public') return true;
  if (!user) return false;
  const [linked] = await db.select({ id: eventPaths.eventId }).from(eventPaths)
    .innerJoin(eventMembers, and(eq(eventMembers.eventId, eventPaths.eventId), eq(eventMembers.userId, user.id)))
    .innerJoin(events, and(eq(events.id, eventPaths.eventId), eq(events.ownerId, path.ownerId), eq(events.visibility, 'private')))
    .innerJoin(eventSpaces, and(eq(eventSpaces.eventId, events.id), eq(eventSpaces.spaceId, space.id)))
    .where(eq(eventPaths.pathId, path.id)).limit(1);
  return !!linked && await canReadSpace(db, user, space);
}

export async function readPath(db: Db, user: AppUser | null, id: string) {
  const [path] = await db.select().from(paths).where(eq(paths.id, id)).limit(1);
  if (!path) throw notFound();
  const [space] = await db.select().from(spaces).where(eq(spaces.id, path.spaceId)).limit(1);
  if (!space || !(await canReadPath(db, user, path, space))) throw notFound();
  return { path, space };
}
