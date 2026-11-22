import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { connectDatabase } from '../../db/client';
import { scans, scanViewers, users } from '../../db/schema';
import type { AppUser } from '../auth/user-sync';
import { canReadScan } from './scans';

/*
 * The three map lists the website reads (apps/web: Your maps, Shared with me, Community).
 * Response shapes follow the reference mock in services/api/README.md, plus `id` on your
 * own maps so the website can edit and delete them through /api/scans/:id. Every row goes
 * through the existing canReadScan check (approval, parent space, visibility, grants), so
 * these lists never show a scan its single-scan routes would refuse.
 */

type Db = ReturnType<typeof connectDatabase>['db'];
type Scan = typeof scans.$inferSelect;

const sharePath = (scan: Scan) => `/s/${scan.shareId}`;

async function readable(db: Db, user: AppUser | null, rows: Scan[]) {
  const visible: Scan[] = [];
  for (const row of rows) if (await canReadScan(db, user, row)) visible.push(row);
  return visible;
}

/** GET /api/scans/mine: the signed-in account's own maps, newest first. */
export async function listMyScans(db: Db, user: AppUser) {
  const rows = await readable(db, user, await db.select().from(scans)
    .where(eq(scans.ownerId, user.id)).orderBy(desc(scans.updatedAt)));
  const grants = rows.length ? await db.select({ scanId: scanViewers.scanId, userId: scanViewers.userId,
    displayName: users.displayName }).from(scanViewers).innerJoin(users, eq(users.id, scanViewers.userId))
    .where(inArray(scanViewers.scanId, rows.map(row => row.id))) : [];
  return rows.map(scan => {
    const viewers = grants.filter(grant => grant.scanId === scan.id)
      .map(grant => ({ id: grant.userId, displayName: grant.displayName }));
    // revisionId lets the owner's review screen load this scan's landmark cues (null for manual uploads).
    return { id: scan.id, shareId: scan.shareId, sharePath: sharePath(scan), name: scan.name,
      format: scan.format, visibility: scan.visibility, status: scan.status, revisionId: scan.sourceRevisionId,
      viewerIds: viewers.map(viewer => viewer.id), viewers, updatedAt: scan.updatedAt };
  });
}

/** GET /api/scans/public: ready public maps anyone may open, newest first. No sign-in needed. */
export async function listPublicScans(db: Db) {
  const rows = await readable(db, null, await db.select().from(scans)
    .where(and(eq(scans.visibility, 'public'), eq(scans.status, 'ready'))).orderBy(desc(scans.updatedAt)));
  return rows.map(scan => ({ shareId: scan.shareId, sharePath: sharePath(scan), name: scan.name,
    updatedAt: scan.updatedAt }));
}

/** GET /api/scans/shared: other accounts' maps this account was added to, without anyone's viewer list. */
export async function listSharedScans(db: Db, user: AppUser) {
  const candidates = await db.select({ scan: scans, owner: users.displayName }).from(scanViewers)
    .innerJoin(scans, eq(scans.id, scanViewers.scanId)).innerJoin(users, eq(users.id, scans.ownerId))
    .where(and(eq(scanViewers.userId, user.id), ne(scans.ownerId, user.id))).orderBy(desc(scans.updatedAt));
  const shared: { scan: Scan; owner: string }[] = [];
  for (const row of candidates) if (await canReadScan(db, user, row.scan)) shared.push(row);
  return shared.map(({ scan, owner }) => ({ shareId: scan.shareId, sharePath: sharePath(scan), name: scan.name,
    format: scan.format, visibility: scan.visibility, owner, updatedAt: scan.updatedAt }));
}
