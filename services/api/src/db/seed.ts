import { connectDatabase } from './client.js';
import {
  destinations, eventDestinations, eventPaths, eventSpaces, events, navEdges,
  navNodes, paths, pathWaypoints, scans, spaces, users,
} from './schema.js';

// Synthetic venue fixture IDs are fixed so re-running the seed is safe.
const ids = {
  user: '00000000-0000-4000-8000-000000000001',
  space: '00000000-0000-4000-8000-000000000002',
  entrance: '00000000-0000-4000-8000-000000000003',
  junction: '00000000-0000-4000-8000-000000000004',
  workshop: '00000000-0000-4000-8000-000000000005',
  booth: '00000000-0000-4000-8000-000000000006',
  edge1: '00000000-0000-4000-8000-000000000007',
  edge2: '00000000-0000-4000-8000-000000000008',
  edge3: '00000000-0000-4000-8000-000000000009',
  destination1: '00000000-0000-4000-8000-000000000010',
  destination2: '00000000-0000-4000-8000-000000000011',
  path: '00000000-0000-4000-8000-000000000012',
  event: '00000000-0000-4000-8000-000000000013',
  scan: '00000000-0000-4000-8000-000000000014',
  share: '00000000-0000-4000-8000-000000000015',
};

const { db, client } = connectDatabase();
try {
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ id: ids.user, auth0Sub: 'seed|organizer', username: 'seed-organizer', displayName: 'Seed Organizer' }).onConflictDoNothing();
    await tx.insert(spaces).values({ id: ids.space, ownerId: ids.user, name: 'Synthetic T Corridor', description: 'Fixture in metres; +Y up and -Z forward', visibility: 'public' }).onConflictDoNothing();
    await tx.insert(navNodes).values([
      { id: ids.entrance, spaceId: ids.space, x: 0, y: 0, z: 0 },
      { id: ids.junction, spaceId: ids.space, x: 0, y: 0, z: -4 },
      { id: ids.workshop, spaceId: ids.space, x: -3, y: 0, z: -4 },
      { id: ids.booth, spaceId: ids.space, x: 3, y: 0, z: -4 },
    ]).onConflictDoNothing();
    await tx.insert(navEdges).values([
      { id: ids.edge1, spaceId: ids.space, fromNodeId: ids.entrance, toNodeId: ids.junction, distance: 4 },
      { id: ids.edge2, spaceId: ids.space, fromNodeId: ids.junction, toNodeId: ids.workshop, distance: 3 },
      { id: ids.edge3, spaceId: ids.space, fromNodeId: ids.junction, toNodeId: ids.booth, distance: 3 },
    ]).onConflictDoNothing();
    await tx.insert(destinations).values([
      { id: ids.destination1, spaceId: ids.space, nodeId: ids.workshop, name: 'Workshop room', category: 'room' },
      { id: ids.destination2, spaceId: ids.space, nodeId: ids.booth, name: 'Info booth', category: 'service' },
    ]).onConflictDoNothing();
    await tx.insert(paths).values({ id: ids.path, ownerId: ids.user, spaceId: ids.space, name: 'Entrance to workshop', visibility: 'public' }).onConflictDoNothing();
    await tx.insert(pathWaypoints).values([
      { pathId: ids.path, spaceId: ids.space, nodeId: ids.entrance, sequence: 0 },
      { pathId: ids.path, spaceId: ids.space, nodeId: ids.junction, sequence: 1 },
      { pathId: ids.path, spaceId: ids.space, nodeId: ids.workshop, sequence: 2 },
    ]).onConflictDoNothing();
    await tx.insert(events).values({ id: ids.event, ownerId: ids.user, name: 'Synthetic Venue Demo', visibility: 'public' }).onConflictDoNothing();
    await tx.insert(eventSpaces).values({ eventId: ids.event, spaceId: ids.space }).onConflictDoNothing();
    await tx.insert(eventPaths).values({ eventId: ids.event, pathId: ids.path }).onConflictDoNothing();
    await tx.insert(eventDestinations).values([
      { eventId: ids.event, destinationId: ids.destination1 },
      { eventId: ids.event, destinationId: ids.destination2 },
    ]).onConflictDoNothing();
    // Object key is a placeholder. No object is uploaded by this seed.
    await tx.insert(scans).values({
      id: ids.scan, spaceId: ids.space, ownerId: ids.user, name: 'Synthetic PLY fixture',
      objectKey: 'seed/synthetic-venue/scene.ply', shareId: ids.share, format: 'ply',
      status: 'pending', visibility: 'private',
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      metadata: { fixturePath: 'fixtures/venue/scene.ply', note: 'Local fixture only; no storage object' },
    }).onConflictDoNothing();
  });
  console.log('Synthetic venue seed ready');
} finally {
  await client.end();
}
