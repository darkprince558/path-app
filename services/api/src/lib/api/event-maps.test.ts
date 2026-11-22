import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { connectDatabase } from '../../db/client';
import { eventMembers, events, scans, spaces, users } from '../../db/schema';
import { LocalScanStorage } from '../storage';
import { GET as mineRoute } from '../../app/api/events/mine/route';
import { POST as addMapRoute } from '../../app/api/events/[id]/maps/route';
import { GET as previewRoute } from '../../app/api/events/[id]/join/route';
import { addEventMap, eventDetail, invitePreview, listEventMembers, listMyEvents, removeEventMap } from './event-maps';
import { readShare } from './shares';
import { canReadScan, createScan, deleteScan, identityTransform } from './scans';

function sampleGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(20 + paddedLength, 0x20);
  bytes.write('glTF', 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(paddedLength, 12); bytes.write('JSON', 16); json.copy(bytes, 20);
  return bytes;
}

test('event routes require sign-in and previews need the right code', async () => {
  const headers = { Authorization: 'Bearer invalid' };
  const params = Promise.resolve({ id: randomUUID() });
  assert.equal((await mineRoute(new Request('http://localhost/api/events/mine', { headers }))).status, 401);
  assert.equal((await addMapRoute(new Request('http://localhost/api/events/x/maps', { method: 'POST', headers, body: '{}' }), { params })).status, 401);
  // An invalid bearer token is rejected even on the preview, which otherwise works signed out.
  const preview = await previewRoute(new Request('http://localhost/api/events/x/join', { headers }), { params });
  assert.equal(preview.status, 401);
});

test('members open exactly the maps attached to an event they joined', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { db, client } = connectDatabase();
  const root = await mkdtemp(path.join(tmpdir(), 'path-app-event-maps-'));
  const storage = new LocalScanStorage(root);
  const suffix = randomUUID();
  const userIds: string[] = [], spaceIds: string[] = [], eventIds: string[] = [];
  const person = (role: string) => db.insert(users).values({ auth0Sub: `test|${suffix}|${role}`,
    username: `events_${suffix}_${role}`, displayName: role }).returning().then(rows => rows[0]);
  try {
    const organizer = await person('Organizer'), member = await person('Member'), outsider = await person('Outsider');
    userIds.push(organizer.id, member.id, outsider.id);
    // A private space holding two private maps: only the attached one may be shared.
    const [space] = await db.insert(spaces).values({ ownerId: organizer.id, name: 'Hall' }).returning();
    const [otherSpace] = await db.insert(spaces).values({ ownerId: outsider.id, name: 'Elsewhere', visibility: 'public' }).returning();
    spaceIds.push(space.id, otherSpace.id);
    const base = { transform: identityTransform, visibility: 'private' as const };
    const shared = await createScan(db, storage, organizer, space.id, { ...base, name: 'Main hall' }, sampleGlb(), 'a.glb');
    const notShared = await createScan(db, storage, organizer, space.id, { ...base, name: 'Back office' }, sampleGlb(), 'b.glb');
    const outsiderMap = await createScan(db, storage, outsider, otherSpace.id, { ...base, name: 'Theirs' }, sampleGlb(), 'c.glb');
    const row = async (id: string) => (await db.select().from(scans).where(eq(scans.id, id)))[0]!;

    const [event] = await db.insert(events).values({ ownerId: organizer.id, name: 'Open day', inviteCode: `code-${suffix}` }).returning();
    eventIds.push(event.id);
    const detail = await addEventMap(db, organizer, event.id, { scanId: shared.id });
    assert.equal(detail.role, 'organizer');
    assert.deepEqual(detail.maps.map(m => m.shareId), [shared.shareId]);
    assert.equal(detail.maps[0]!.id, shared.id); // the organizer gets edit IDs
    assert.equal((await addEventMap(db, organizer, event.id, { scanId: shared.id })).maps.length, 1); // idempotent

    // Only the organizer attaches, and only their own maps.
    await assert.rejects(addEventMap(db, organizer, event.id, { scanId: outsiderMap.id }), { status: 404 });
    await assert.rejects(addEventMap(db, outsider, event.id, { scanId: outsiderMap.id }), { status: 404 }); // can't even see it

    // Before joining: nothing. The invite preview needs the exact code.
    assert.equal(await canReadScan(db, member, await row(shared.id)), false);
    await assert.rejects(invitePreview(db, member, event.id, 'wrong'), { status: 404 });
    await assert.rejects(invitePreview(db, member, event.id, null), { status: 404 });
    const preview = await invitePreview(db, member, event.id, `code-${suffix}`);
    assert.deepEqual({ name: preview.event.name, organizer: preview.organizer, mapCount: preview.mapCount, role: preview.role },
      { name: 'Open day', organizer: 'Organizer', mapCount: 1, role: null });

    await db.insert(eventMembers).values({ eventId: event.id, userId: member.id });
    assert.equal(await canReadScan(db, member, await row(shared.id)), true);
    assert.equal((await readShare(db, member, shared.shareId)).id, shared.id); // guest view, places, cues
    assert.equal(await canReadScan(db, member, await row(notShared.id)), false); // same space, not attached
    assert.equal(await canReadScan(db, outsider, await row(shared.id)), false);
    const memberView = await eventDetail(db, member, event);
    assert.equal(memberView.role, 'member');
    assert.deepEqual(memberView.maps.map(m => m.shareId), [shared.shareId]);
    assert.equal('id' in memberView.maps[0]!, false);
    assert.equal('inviteCode' in memberView.event, false);
    assert.equal((await invitePreview(db, member, event.id, `code-${suffix}`)).role, 'member');

    const mine = await listMyEvents(db, member);
    assert.deepEqual(mine.events.map(e => [e.id, e.role, e.mapCount, e.memberCount]), [[event.id, 'member', 1, 1]]);
    assert.deepEqual((await listMyEvents(db, organizer)).events.map(e => e.role), ['organizer']);
    assert.deepEqual((await listMyEvents(db, outsider)).events, []);
    assert.deepEqual((await listEventMembers(db, organizer, event.id)).members.map(m => m.displayName), ['Member']);
    await assert.rejects(listEventMembers(db, member, event.id), { status: 403 });

    // Detaching or leaving removes access on the next request.
    await removeEventMap(db, organizer, event.id, shared.id);
    assert.equal(await canReadScan(db, member, await row(shared.id)), false);
    await addEventMap(db, organizer, event.id, { scanId: shared.id });
    await db.delete(eventMembers).where(eq(eventMembers.userId, member.id));
    assert.equal(await canReadScan(db, member, await row(shared.id)), false);
    await assert.rejects(removeEventMap(db, member, event.id, shared.id), { status: 404 });

    // Deleting the map removes it from the event.
    await deleteScan(db, storage, organizer, shared.id);
    assert.deepEqual((await eventDetail(db, organizer, event)).maps, []);
  } finally {
    if (eventIds.length) await db.delete(events).where(inArray(events.id, eventIds));
    for (const spaceId of spaceIds) {
      await db.delete(scans).where(eq(scans.spaceId, spaceId));
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    }
    for (const userId of userIds) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
    await client.end();
    await rm(root, { recursive: true, force: true });
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});
