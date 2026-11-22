import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { scanPlaces, scans, spaces, users } from '../../db/schema';
import { createPlace, deletePlace, listSharePlaces, MAX_PLACES_PER_SCAN, placeInput, placePatch, updatePlace } from './places';
import { GET as sharePlacesRoute } from '../../app/api/shares/[shareId]/places/route';
import { POST as createPlaceRoute } from '../../app/api/scans/[id]/places/route';
import { DELETE as deletePlaceRoute, PATCH as patchPlaceRoute } from '../../app/api/places/[id]/route';

test('place input is cleaned and validated', () => {
  const ok = placeInput.parse({ name: '  Room   214 ', position: { x: 1, y: 0, z: -2.5 } });
  assert.deepEqual(ok, { name: 'Room 214', category: 'room', position: { x: 1, y: 0, z: -2.5 } });
  assert.equal(placeInput.parse({ name: 'Exit', category: 'exit', position: { x: 0, y: 0, z: 0 } }).category, 'exit');
  for (const bad of [
    { name: '', position: { x: 0, y: 0, z: 0 } },
    { name: '   ', position: { x: 0, y: 0, z: 0 } },
    { name: 'x'.repeat(81), position: { x: 0, y: 0, z: 0 } },
    { name: 'Room\u0007', position: { x: 0, y: 0, z: 0 } },
    { name: 'Room', category: 'dungeon', position: { x: 0, y: 0, z: 0 } },
    { name: 'Room', position: { x: Number.NaN, y: 0, z: 0 } },
    { name: 'Room', position: { x: 1e9, y: 0, z: 0 } },
    { name: 'Room', position: { x: 0, y: 0 } },
    { name: 'Room', position: { x: 0, y: 0, z: 0 }, extra: true },
  ]) assert.equal(placeInput.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(placePatch.safeParse({}).success, false);
  assert.equal(placePatch.parse({ category: 'washroom' }).category, 'washroom');
});

test('changing places requires sign-in', async () => {
  const id = randomUUID(), headers = { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' };
  const body = JSON.stringify({ name: 'Room 2', position: { x: 0, y: 0, z: 0 } });
  const created = await createPlaceRoute(new Request(`http://localhost/api/scans/${id}/places`, { method: 'POST', headers, body }),
    { params: Promise.resolve({ id }) });
  const patched = await patchPlaceRoute(new Request(`http://localhost/api/places/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: 'B' }) }),
    { params: Promise.resolve({ id }) });
  const deleted = await deletePlaceRoute(new Request(`http://localhost/api/places/${id}`, { method: 'DELETE', headers }),
    { params: Promise.resolve({ id }) });
  assert.deepEqual([created.status, patched.status, deleted.status], [401, 401, 401]);
  const read = await sharePlacesRoute(new Request(`http://localhost/api/shares/${id}/places`, { headers }),
    { params: Promise.resolve({ shareId: id }) });
  assert.equal(read.status, 401); // a bad token is rejected even on a public read
});

test('owners pin places; guests read them only where the share is readable', { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 }, async () => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 5, prepare: false }); const db = drizzle(client);
  const userIds: string[] = []; const spaceIds: string[] = [];
  try {
    const suffix = randomUUID();
    const [owner, other] = await db.insert(users).values([
      { auth0Sub: `places|${suffix}`, username: `places_${suffix}`, displayName: 'Owner' },
      { auth0Sub: `places-other|${suffix}`, username: `places_other_${suffix}`, displayName: 'Other' },
    ]).returning(); userIds.push(owner.id, other.id);
    // Like a browser upload: an unlisted container space; the scan's own visibility controls reads.
    const [space] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Uploaded map', visibility: 'unlisted' }).returning();
    spaceIds.push(space.id);
    const [scan] = await db.insert(scans).values({ spaceId: space.id, ownerId: owner.id, name: 'Hallway',
      objectKey: `scans/${randomUUID()}.glb`, format: 'glb', status: 'ready', visibility: 'private',
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }).returning();

    const room = await createPlace(db, owner, scan.id, placeInput.parse({ name: ' Room  2 ', position: { x: 1.5, y: 0, z: -3 } }));
    const exit = await createPlace(db, owner, scan.id, placeInput.parse({ name: 'Exit', category: 'exit', position: { x: -2, y: 0.1, z: 4 } }));
    assert.equal(room.name, 'Room 2');
    assert.equal(room.category, 'room');
    assert.deepEqual(room.position, { x: 1.5, y: 0, z: -3 });

    // Only the owner may add, change or remove places.
    await assert.rejects(createPlace(db, other, scan.id, placeInput.parse({ name: 'Mine', position: { x: 0, y: 0, z: 0 } })), { status: 403 });
    await assert.rejects(updatePlace(db, other, room.id, { name: 'Hijacked' }), { status: 404 });
    await assert.rejects(deletePlace(db, other, room.id), { status: 404 });
    await assert.rejects(createPlace(db, owner, randomUUID(), placeInput.parse({ name: 'X', position: { x: 0, y: 0, z: 0 } })), { status: 404 });

    // Private map: owner sees the places, guests and other users don't.
    assert.deepEqual((await listSharePlaces(db, owner, scan.shareId)).map(p => p.name), ['Exit', 'Room 2']);
    await assert.rejects(listSharePlaces(db, null, scan.shareId), { status: 404 });
    await assert.rejects(listSharePlaces(db, other, scan.shareId), { status: 404 });

    // Once unlisted, anyone with the link sees them; private again hides them.
    await db.update(scans).set({ visibility: 'unlisted' }).where(eq(scans.id, scan.id));
    assert.deepEqual((await listSharePlaces(db, null, scan.shareId)).map(p => p.category), ['exit', 'room']);
    await db.update(scans).set({ visibility: 'private' }).where(eq(scans.id, scan.id));
    await assert.rejects(listSharePlaces(db, null, scan.shareId), { status: 404 });

    // Rename, re-categorise and move.
    const moved = await updatePlace(db, owner, room.id, { name: 'Room 214', category: 'office', position: { x: 2, y: 0, z: -3.5 } });
    assert.deepEqual([moved.name, moved.category, moved.position], ['Room 214', 'office', { x: 2, y: 0, z: -3.5 }]);
    await deletePlace(db, owner, exit.id);
    assert.deepEqual((await listSharePlaces(db, owner, scan.shareId)).map(p => p.name), ['Room 214']);

    // The per-map limit.
    await db.insert(scanPlaces).values(Array.from({ length: MAX_PLACES_PER_SCAN - 1 }, (_, i) => ({
      scanId: scan.id, name: `Booth ${i}`, x: i, y: 0, z: 0, createdBy: owner.id })));
    await assert.rejects(createPlace(db, owner, scan.id, placeInput.parse({ name: 'One too many', position: { x: 0, y: 0, z: 0 } })), { status: 409 });

    // Deleting the scan removes its places.
    await db.delete(scans).where(eq(scans.id, scan.id));
    assert.equal((await db.select().from(scanPlaces).where(eq(scanPlaces.scanId, scan.id))).length, 0);
  } finally {
    if (spaceIds.length) { await db.delete(scans).where(inArray(scans.spaceId, spaceIds)); await db.delete(spaces).where(inArray(spaces.id, spaceIds)); }
    for (const id of userIds) await db.delete(users).where(eq(users.id, id)).catch(() => {});
    await client.end();
  }
});
