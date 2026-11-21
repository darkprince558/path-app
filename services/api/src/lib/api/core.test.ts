import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { connectDatabase } from '../../db/client';
import { destinations, eventMembers, eventSpaces, events, navEdges, navNodes, paths, pathWaypoints, spaces, users } from '../../db/schema';
import { canReadPath, canReadSpace, readSpace } from './access';
import { validateEventLinks } from './events';
import { validateWaypoints } from './paths';

test('database CRUD, graph integrity, path and event access', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { db, client } = connectDatabase();
  const suffix = randomUUID();
  let ownerId: string | undefined;
  let viewerId: string | undefined;
  let spaceId: string | undefined;
  let otherSpaceId: string | undefined;
  let pathId: string | undefined;
  let destinationId: string | undefined;
  let eventId: string | undefined;
  try {
    const [owner] = await db.insert(users).values({ auth0Sub: `test|${suffix}|owner`, username: `test_${suffix}_owner`, displayName: 'Owner' }).returning();
    const [viewer] = await db.insert(users).values({ auth0Sub: `test|${suffix}|viewer`, username: `test_${suffix}_viewer`, displayName: 'Viewer' }).returning();
    ownerId = owner.id; viewerId = viewer.id;
    const [space] = await db.insert(spaces).values({ ownerId: owner.id, name: 'Test venue', visibility: 'private' }).returning();
    spaceId = space.id;
    assert.equal((await readSpace(db, owner, space.id)).id, space.id);
    assert.equal(await canReadSpace(db, viewer, space), false);
    await assert.rejects(readSpace(db, viewer, space.id));
    const [otherSpace] = await db.insert(spaces).values({ ownerId: viewer.id, name: 'Other venue' }).returning();
    otherSpaceId = otherSpace.id;
    const [a, b] = await db.insert(navNodes).values([
      { spaceId: space.id, x: 0, y: 0, z: 0 },
      { spaceId: space.id, x: 1, y: 0, z: 0 },
    ]).returning();
    const [foreignNode] = await db.insert(navNodes).values({ spaceId: otherSpace.id, x: 0, y: 0, z: 0 }).returning();
    await assert.rejects(db.insert(navEdges).values({ spaceId: space.id, fromNodeId: a.id, toNodeId: foreignNode.id, distance: 1 }));
    await db.insert(navEdges).values({ spaceId: space.id, fromNodeId: a.id, toNodeId: b.id, distance: 1, bidirectional: false });
    await validateWaypoints(db, space.id, [a.id, b.id]);
    await assert.rejects(validateWaypoints(db, space.id, [b.id, a.id]));
    await assert.rejects(validateWaypoints(db, space.id, [a.id, foreignNode.id]));
    const [destination] = await db.insert(destinations).values({ spaceId: space.id, nodeId: b.id, name: 'Registration' }).returning();
    destinationId = destination.id;
    const [path] = await db.insert(paths).values({ ownerId: owner.id, spaceId: space.id, name: 'Entrance to registration' }).returning();
    pathId = path.id;
    await db.insert(pathWaypoints).values([
      { pathId: path.id, spaceId: space.id, nodeId: a.id, sequence: 0 },
      { pathId: path.id, spaceId: space.id, nodeId: b.id, sequence: 1 },
    ]);
    assert.equal(await canReadPath(db, viewer, path, space), false);
    await assert.rejects(validateEventLinks(db, owner.id, 'public', { spaceIds: [space.id], pathIds: [path.id], destinationIds: [destination.id] }));
    const [event] = await db.insert(events).values({ ownerId: owner.id, name: 'Private event', inviteCode: `test-${suffix}` }).returning();
    eventId = event.id;
    await db.insert(eventSpaces).values({ eventId: event.id, spaceId: space.id });
    await db.insert(eventMembers).values({ eventId: event.id, userId: viewer.id });
    assert.equal(await canReadSpace(db, viewer, space), true);
    await db.delete(eventMembers).where(and(eq(eventMembers.eventId, event.id), eq(eventMembers.userId, viewer.id)));
    assert.equal(await canReadSpace(db, viewer, space), false);
    const [updated] = await db.update(spaces).set({ name: 'Updated venue', visibility: 'public' }).where(eq(spaces.id, space.id)).returning();
    assert.equal(updated.name, 'Updated venue');
    assert.equal(await canReadSpace(db, null, updated), true);
  } finally {
    if (eventId) await db.delete(events).where(eq(events.id, eventId));
    if (pathId) await db.delete(paths).where(eq(paths.id, pathId));
    if (destinationId) await db.delete(destinations).where(eq(destinations.id, destinationId));
    if (spaceId) {
      await db.delete(navEdges).where(eq(navEdges.spaceId, spaceId));
      await db.delete(navNodes).where(eq(navNodes.spaceId, spaceId));
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    }
    if (otherSpaceId) {
      await db.delete(navNodes).where(eq(navNodes.spaceId, otherSpaceId));
      await db.delete(spaces).where(eq(spaces.id, otherSpaceId));
    }
    if (ownerId) await db.delete(users).where(eq(users.id, ownerId)).catch(() => {});
    if (viewerId) await db.delete(users).where(eq(users.id, viewerId)).catch(() => {});
    await client.end();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});
