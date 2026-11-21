import { sql } from 'drizzle-orm';
import {
  boolean, check, doublePrecision, foreignKey, index, integer, jsonb,
  pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

export const visibility = pgEnum('visibility', ['private', 'unlisted', 'public']);
export const scanFormat = pgEnum('scan_format', ['ply', 'glb']);
export const scanStatus = pgEnum('scan_status', ['pending', 'ready', 'failed']);
export const eventRole = pgEnum('event_role', ['member', 'organizer']);

const id = () => uuid('id').defaultRandom().primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
const metadata = () => jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull();

export const users = pgTable('users', {
  id: id(), auth0Sub: text('auth0_sub').notNull().unique(),
  username: text('username').notNull(), displayName: text('display_name').notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('users_username_unique').on(t.username)]);

export const spaces = pgTable('spaces', {
  id: id(), ownerId: uuid('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(), description: text('description'),
  visibility: visibility('visibility').default('private').notNull(),
  boundary: jsonb('boundary').$type<Record<string, unknown>>(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('spaces_owner_idx').on(t.ownerId), index('spaces_visibility_idx').on(t.visibility)]);

export const scans = pgTable('scans', {
  id: id(), spaceId: uuid('space_id').notNull().references(() => spaces.id),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(), objectKey: text('object_key').notNull().unique(),
  shareId: uuid('share_id').defaultRandom().notNull().unique(),
  format: scanFormat('format').notNull(), status: scanStatus('status').default('pending').notNull(),
  byteSize: integer('byte_size'),
  transform: jsonb('transform').$type<number[]>().notNull(),
  visibility: visibility('visibility').default('private').notNull(), metadata: metadata(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index('scans_space_idx').on(t.spaceId), index('scans_owner_idx').on(t.ownerId),
  index('scans_visibility_status_idx').on(t.visibility, t.status),
  check('scans_byte_size_check', sql`${t.byteSize} IS NULL OR ${t.byteSize} >= 0`),
  check('scans_transform_length_check', sql`jsonb_typeof(${t.transform}) = 'array' AND jsonb_array_length(${t.transform}) = 16`),
]);

export const scanViewers = pgTable('scan_viewers', {
  scanId: uuid('scan_id').notNull().references(() => scans.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.scanId, t.userId] }), index('scan_viewers_user_idx').on(t.userId)]);

export const navNodes = pgTable('nav_nodes', {
  id: id(), spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  x: doublePrecision('x').notNull(), y: doublePrecision('y').notNull(), z: doublePrecision('z').notNull(),
  floor: integer('floor'), metadata: metadata(),
}, (t) => [
  unique('nav_nodes_id_space_unique').on(t.id, t.spaceId),
  index('nav_nodes_space_idx').on(t.spaceId),
  check('nav_nodes_finite_check', sql`${t.x} > '-Infinity'::float8 AND ${t.x} < 'Infinity'::float8 AND ${t.y} > '-Infinity'::float8 AND ${t.y} < 'Infinity'::float8 AND ${t.z} > '-Infinity'::float8 AND ${t.z} < 'Infinity'::float8`),
]);

export const navEdges = pgTable('nav_edges', {
  id: id(), spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  fromNodeId: uuid('from_node_id').notNull(), toNodeId: uuid('to_node_id').notNull(),
  distance: doublePrecision('distance').notNull(), accessible: boolean('accessible').default(true).notNull(),
  bidirectional: boolean('bidirectional').default(true).notNull(), metadata: metadata(),
}, (t) => [
  foreignKey({ columns: [t.fromNodeId, t.spaceId], foreignColumns: [navNodes.id, navNodes.spaceId] }),
  foreignKey({ columns: [t.toNodeId, t.spaceId], foreignColumns: [navNodes.id, navNodes.spaceId] }),
  index('nav_edges_space_idx').on(t.spaceId), index('nav_edges_from_idx').on(t.fromNodeId),
  index('nav_edges_to_idx').on(t.toNodeId),
  check('nav_edges_distance_check', sql`${t.distance} > 0 AND ${t.distance} < 'Infinity'::float8`),
  check('nav_edges_distinct_nodes_check', sql`${t.fromNodeId} <> ${t.toNodeId}`),
]);

export const destinations = pgTable('destinations', {
  id: id(), spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  nodeId: uuid('node_id').notNull(), name: text('name').notNull(),
  description: text('description'), category: text('category'),
}, (t) => [
  unique('destinations_id_space_unique').on(t.id, t.spaceId),
  foreignKey({ columns: [t.nodeId, t.spaceId], foreignColumns: [navNodes.id, navNodes.spaceId] }),
  index('destinations_space_idx').on(t.spaceId),
]);

export const paths = pgTable('paths', {
  id: id(), ownerId: uuid('owner_id').notNull().references(() => users.id),
  spaceId: uuid('space_id').notNull().references(() => spaces.id),
  name: text('name').notNull(), description: text('description'),
  visibility: visibility('visibility').default('private').notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  unique('paths_id_space_unique').on(t.id, t.spaceId),
  index('paths_space_idx').on(t.spaceId), index('paths_owner_idx').on(t.ownerId),
  index('paths_visibility_idx').on(t.visibility),
]);

export const pathWaypoints = pgTable('path_waypoints', {
  pathId: uuid('path_id').notNull(), spaceId: uuid('space_id').notNull(),
  nodeId: uuid('node_id').notNull(), sequence: integer('sequence').notNull(),
}, (t) => [
  primaryKey({ columns: [t.pathId, t.sequence] }),
  foreignKey({ columns: [t.pathId, t.spaceId], foreignColumns: [paths.id, paths.spaceId], name: 'path_waypoints_path_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.nodeId, t.spaceId], foreignColumns: [navNodes.id, navNodes.spaceId], name: 'path_waypoints_node_fk' }),
  index('path_waypoints_node_idx').on(t.nodeId),
  check('path_waypoints_sequence_check', sql`${t.sequence} >= 0`),
]);

export const events = pgTable('events', {
  id: id(), ownerId: uuid('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(), description: text('description'),
  visibility: visibility('visibility').default('private').notNull(),
  inviteCode: text('invite_code').unique(), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('events_owner_idx').on(t.ownerId), index('events_visibility_idx').on(t.visibility)]);

export const eventMembers = pgTable('event_members', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: eventRole('role').default('member').notNull(),
}, (t) => [primaryKey({ columns: [t.eventId, t.userId] }), index('event_members_user_idx').on(t.userId)]);

export const eventSpaces = pgTable('event_spaces', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  spaceId: uuid('space_id').notNull().references(() => spaces.id),
}, (t) => [primaryKey({ columns: [t.eventId, t.spaceId] }), index('event_spaces_space_idx').on(t.spaceId)]);

export const eventPaths = pgTable('event_paths', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  pathId: uuid('path_id').notNull().references(() => paths.id),
}, (t) => [primaryKey({ columns: [t.eventId, t.pathId] }), index('event_paths_path_idx').on(t.pathId)]);

export const eventDestinations = pgTable('event_destinations', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  destinationId: uuid('destination_id').notNull().references(() => destinations.id),
}, (t) => [primaryKey({ columns: [t.eventId, t.destinationId] }), index('event_destinations_destination_idx').on(t.destinationId)]);
