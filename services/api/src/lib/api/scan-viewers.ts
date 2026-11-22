import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { connectDatabase } from '../../db/client';
import { scanViewers, users } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import { requireOwner } from '../auth/authorization';
import { ApiError, badRequest } from './http';
import { readScan } from './scans';
import { uuid } from './validation';

type Db = ReturnType<typeof connectDatabase>['db'];

export const viewerInput = z.object({ email: z.string().trim().toLowerCase().max(320).email() }).strict();

/** The owner's view of who was added to a map. Only the owner ever sees these emails. */
export async function listViewers(db: Db, user: AppUser, scanId: string) {
  const scan = await readScan(db, user, scanId);
  requireOwner(user, scan.ownerId);
  const viewers = await db.select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(scanViewers).innerJoin(users, eq(users.id, scanViewers.userId))
    .where(eq(scanViewers.scanId, scan.id)).orderBy(users.displayName);
  return { viewers };
}

/**
 * Grants every account with this verified email (one person can have several Auth0 logins).
 * Grants are stored whatever the map's visibility; they matter while it is Private.
 */
export async function addViewer(db: Db, user: AppUser, scanId: string, input: z.infer<typeof viewerInput>) {
  const scan = await readScan(db, user, scanId);
  requireOwner(user, scan.ownerId);
  const matches = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.email, input.email), ne(users.id, scan.ownerId)));
  if (!matches.length) {
    if (user.email === input.email) throw badRequest('That is your own email. You can already open your maps.');
    throw new ApiError(404, 'USER_NOT_FOUND', 'No account uses that email yet. Ask them to sign in to Not 404 once, then add them again.');
  }
  await db.insert(scanViewers).values(matches.map(match => ({ scanId: scan.id, userId: match.id }))).onConflictDoNothing();
  return listViewers(db, user, scan.id);
}

export async function removeViewer(db: Db, user: AppUser, scanId: string, viewerId: string) {
  const scan = await readScan(db, user, scanId);
  requireOwner(user, scan.ownerId);
  await db.delete(scanViewers).where(and(eq(scanViewers.scanId, scan.id), eq(scanViewers.userId, uuid.parse(viewerId))));
  return listViewers(db, user, scan.id);
}
