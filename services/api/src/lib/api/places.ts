import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { connectDatabase } from '../../db/client';
import { scanPlaceCategory, scanPlaces, scans } from '../../db/schema';
import { requireOwner } from '../auth/authorization';
import type { AppUser } from '../auth/user-sync';
import { conflict, notFound } from './http';
import { readShare } from './shares';
import { uuid } from './validation';

/*
 * Named places pinned on a scan, so first-time visitors can see what is where.
 *
 *   GET    /api/shares/:shareId/places   anyone who may open the share
 *   POST   /api/scans/:scanId/places     owner: {name, category?, position: {x,y,z}}
 *   PATCH  /api/places/:id               owner: {name?, category?, position?}
 *   DELETE /api/places/:id               owner
 *
 * `position` is in the scan's own model coordinates (the GLB before scan.transform), so a pin
 * stays on its spot when the owner re-aligns the scan. Places carry no private data and follow
 * the scan's sharing rules.
 */

type Db = ReturnType<typeof connectDatabase>['db'];
type PlaceRow = typeof scanPlaces.$inferSelect;

export const MAX_PLACE_NAME_LENGTH = 80;
export const MAX_PLACES_PER_SCAN = 200;
export const PLACE_CATEGORIES = scanPlaceCategory.enumValues;

/** Collapses whitespace; 1-80 characters; no control characters. */
const placeName = z.string().transform(value => value.split(/\s+/).filter(Boolean).join(' '))
  .pipe(z.string().min(1).max(MAX_PLACE_NAME_LENGTH).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'No control characters'));
const coordinate = z.number().finite().min(-100_000).max(100_000);
const position = z.object({ x: coordinate, y: coordinate, z: coordinate }).strict();

export const placeInput = z.object({
  name: placeName, category: z.enum(PLACE_CATEGORIES).default('room'), position,
}).strict();
export const placePatch = z.object({
  name: placeName.optional(), category: z.enum(PLACE_CATEGORIES).optional(), position: position.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Send name, category or position');

export function placeResponse(place: PlaceRow) {
  return { id: place.id, scanId: place.scanId, name: place.name, category: place.category,
    position: { x: place.x, y: place.y, z: place.z }, updatedAt: place.updatedAt.toISOString() };
}

/** Places for a share, sorted by name, under the share's own access rules. */
export async function listSharePlaces(db: Db, user: AppUser | null, shareId: string) {
  const scan = await readShare(db, user, shareId);
  const rows = await db.select().from(scanPlaces).where(eq(scanPlaces.scanId, scan.id))
    .orderBy(asc(scanPlaces.name), asc(scanPlaces.id));
  return rows.map(placeResponse);
}

async function ownedScan(db: Db, user: AppUser, scanId: string) {
  const [scan] = await db.select().from(scans).where(eq(scans.id, uuid.parse(scanId))).limit(1);
  if (!scan) throw notFound();
  requireOwner(user, scan.ownerId);
  return scan;
}

export async function createPlace(db: Db, user: AppUser, scanId: string, input: z.infer<typeof placeInput>) {
  const scan = await ownedScan(db, user, scanId);
  return db.transaction(async tx => {
    // Lock the scan row so two concurrent creates can't both pass the limit.
    await tx.select({ id: scans.id }).from(scans).where(eq(scans.id, scan.id)).for('update');
    const [{ value }] = await tx.select({ value: count() }).from(scanPlaces).where(eq(scanPlaces.scanId, scan.id));
    if (value >= MAX_PLACES_PER_SCAN) throw conflict(`A map can have at most ${MAX_PLACES_PER_SCAN} places`);
    const [place] = await tx.insert(scanPlaces).values({ scanId: scan.id, name: input.name, category: input.category,
      ...input.position, createdBy: user.id }).returning();
    return placeResponse(place);
  });
}

async function ownedPlace(db: Db, user: AppUser, placeId: string) {
  const [row] = await db.select({ place: scanPlaces, ownerId: scans.ownerId }).from(scanPlaces)
    .innerJoin(scans, eq(scans.id, scanPlaces.scanId)).where(eq(scanPlaces.id, uuid.parse(placeId))).limit(1);
  // Hide other people's places entirely: 404, not 403.
  if (!row || row.ownerId !== user.id) throw notFound();
  return row.place;
}

export async function updatePlace(db: Db, user: AppUser, placeId: string, input: z.infer<typeof placePatch>) {
  const place = await ownedPlace(db, user, placeId);
  const [updated] = await db.update(scanPlaces).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.position ? input.position : {}),
    updatedAt: new Date(),
  }).where(and(eq(scanPlaces.id, place.id), eq(scanPlaces.scanId, place.scanId))).returning();
  return placeResponse(updated);
}

export async function deletePlace(db: Db, user: AppUser, placeId: string) {
  const place = await ownedPlace(db, user, placeId);
  await db.delete(scanPlaces).where(eq(scanPlaces.id, place.id));
}
