import { sql } from 'drizzle-orm';
import {
  boolean, check, doublePrecision, foreignKey, index, integer, jsonb,
  pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const visibility = pgEnum('visibility', ['private', 'unlisted', 'public']);
export const scanFormat = pgEnum('scan_format', ['ply', 'glb']);
export const scanStatus = pgEnum('scan_status', ['pending', 'ready', 'failed']);
export const eventRole = pgEnum('event_role', ['member', 'organizer']);
export const captureStatus = pgEnum('capture_status', ['uploading', 'uploaded', 'failed', 'cancelled']);
export const processingJobStatus = pgEnum('processing_job_status', ['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const scanRevisionStatus = pgEnum('scan_revision_status', ['draft', 'approved', 'rejected', 'superseded']);

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
}, (t) => [
  unique('spaces_id_owner_unique').on(t.id, t.ownerId),
  index('spaces_owner_idx').on(t.ownerId), index('spaces_visibility_idx').on(t.visibility),
]);

export const scans = pgTable('scans', {
  id: id(), spaceId: uuid('space_id').notNull().references(() => spaces.id),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(), objectKey: text('object_key').notNull().unique(),
  shareId: uuid('share_id').defaultRandom().notNull().unique(),
  sourceRevisionId: uuid('source_revision_id').unique().references((): AnyPgColumn => scanRevisions.id),
  format: scanFormat('format').notNull(), status: scanStatus('status').default('pending').notNull(),
  byteSize: integer('byte_size'),
  transform: jsonb('transform').$type<number[]>().notNull(),
  visibility: visibility('visibility').default('private').notNull(), metadata: metadata(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  unique('scans_id_space_unique').on(t.id, t.spaceId),
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
  index('nav_edges_space_endpoints_idx').on(t.spaceId, t.fromNodeId, t.toNodeId),
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

// Raw bundle metadata is owner-only. This schema does not publish captures or grant access.
// The manifest holds the complete file inventory (paths, sizes, checksums); bytes stay in storage.
export const captures = pgTable('captures', {
  id: id(), ownerId: uuid('owner_id').notNull().references(() => users.id),
  spaceId: uuid('space_id').notNull(), deviceCaptureId: text('device_capture_id').notNull(),
  manifestVersion: integer('manifest_version').notNull(),
  manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  manifestSha256: text('manifest_sha256').notNull(),
  bundleObjectPrefix: text('bundle_object_prefix').notNull().unique(),
  device: jsonb('device').$type<Record<string, unknown>>().notNull(),
  coordinateSystem: jsonb('coordinate_system').$type<Record<string, unknown>>().notNull(),
  entrancePose: jsonb('entrance_pose').$type<number[]>().notNull(),
  trackingWarnings: jsonb('tracking_warnings').$type<string[]>().default([]).notNull(),
  status: captureStatus('status').default('uploading').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  unique('captures_owner_device_unique').on(t.ownerId, t.deviceCaptureId),
  unique('captures_id_space_unique').on(t.id, t.spaceId),
  foreignKey({ columns: [t.spaceId, t.ownerId], foreignColumns: [spaces.id, spaces.ownerId], name: 'captures_space_owner_fk' }),
  index('captures_space_idx').on(t.spaceId), index('captures_status_idx').on(t.status),
  check('captures_device_id_check', sql`length(trim(${t.deviceCaptureId})) > 0`),
  check('captures_manifest_version_check', sql`${t.manifestVersion} > 0`),
  check('captures_manifest_sha256_check', sql`${t.manifestSha256} ~ '^[0-9a-f]{64}$'`),
  check('captures_manifest_object_check', sql`jsonb_typeof(${t.manifest}) = 'object'`),
  check('captures_device_object_check', sql`jsonb_typeof(${t.device}) = 'object'`),
  check('captures_coordinate_object_check', sql`jsonb_typeof(${t.coordinateSystem}) = 'object'`),
  check('captures_entrance_pose_check', sql`jsonb_typeof(${t.entrancePose}) = 'array' AND jsonb_array_length(${t.entrancePose}) = 16`),
  check('captures_tracking_warnings_check', sql`jsonb_typeof(${t.trackingWarnings}) = 'array'`),
  check('captures_uploaded_at_check', sql`${t.status} <> 'uploaded' OR ${t.uploadedAt} IS NOT NULL`),
]);

// Stable frame IDs survive processing retries; approval belongs to a revision, not the raw image.
export const captureFrames = pgTable('capture_frames', {
  captureId: uuid('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),
  frameId: text('frame_id').notNull(), objectKey: text('object_key').notNull().unique(),
  sha256: text('sha256').notNull(),
  cameraPose: jsonb('camera_pose').$type<number[]>().notNull(),
  intrinsics: jsonb('intrinsics').$type<Record<string, unknown>>(),
  timestampSeconds: doublePrecision('timestamp_seconds'),
  width: integer('width'), height: integer('height'), metadata: metadata(),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.captureId, t.frameId] }),
  check('capture_frames_id_check', sql`length(trim(${t.frameId})) > 0`),
  check('capture_frames_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check('capture_frames_pose_check', sql`jsonb_typeof(${t.cameraPose}) = 'array' AND jsonb_array_length(${t.cameraPose}) = 16`),
  check('capture_frames_timestamp_check', sql`${t.timestampSeconds} IS NULL OR (${t.timestampSeconds} >= 0 AND ${t.timestampSeconds} < 'Infinity'::float8)`),
  check('capture_frames_dimensions_check', sql`(${t.width} IS NULL AND ${t.height} IS NULL) OR (${t.width} IS NOT NULL AND ${t.height} IS NOT NULL AND ${t.width} > 0 AND ${t.height} > 0)`),
]);

export const processingJobs = pgTable('processing_jobs', {
  id: id(), captureId: uuid('capture_id').notNull().references(() => captures.id),
  jobType: text('job_type').default('capture').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  inputSha256: text('input_sha256').notNull(), processorVersion: text('processor_version').notNull(),
  configuration: jsonb('configuration').$type<Record<string, unknown>>().default({}).notNull(),
  status: processingJobStatus('status').default('queued').notNull(),
  stage: text('stage'), progress: integer('progress').default(0).notNull(),
  attemptCount: integer('attempt_count').default(0).notNull(),
  leaseToken: uuid('lease_token'), leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  errorCode: text('error_code'), metadata: metadata(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  unique('processing_jobs_capture_key_unique').on(t.captureId, t.idempotencyKey),
  unique('processing_jobs_id_capture_unique').on(t.id, t.captureId),
  index('processing_jobs_queue_idx').on(t.status, t.createdAt),
  index('processing_jobs_lease_idx').on(t.status, t.leaseExpiresAt),
  uniqueIndex('processing_jobs_one_running').on(sql`(1)`).where(sql`${t.status} = 'running'`),
  check('processing_jobs_key_check', sql`length(trim(${t.idempotencyKey})) > 0`),
  check('processing_jobs_type_check', sql`length(trim(${t.jobType})) > 0`),
  check('processing_jobs_version_check', sql`length(trim(${t.processorVersion})) > 0`),
  check('processing_jobs_input_sha256_check', sql`${t.inputSha256} ~ '^[0-9a-f]{64}$'`),
  check('processing_jobs_progress_check', sql`${t.progress} BETWEEN 0 AND 100`),
  check('processing_jobs_attempts_check', sql`${t.attemptCount} >= 0`),
  check('processing_jobs_lease_check', sql`(${t.leaseToken} IS NULL) = (${t.leaseExpiresAt} IS NULL)`),
]);

// Candidate outputs do not replace scans.object_key or the published navigation graph.
// Evidence frame IDs in metadata are scoped to captureId; future writes must validate each ID.
export const scanRevisions = pgTable('scan_revisions', {
  id: id(), captureId: uuid('capture_id').notNull(), spaceId: uuid('space_id').notNull(),
  processingJobId: uuid('processing_job_id').notNull(),
  scanId: uuid('scan_id'), revision: integer('revision').notNull(),
  status: scanRevisionStatus('status').default('draft').notNull(),
  objectKey: text('object_key').notNull().unique(), graphObjectKey: text('graph_object_key'),
  outputSha256: text('output_sha256').notNull(),
  transform: jsonb('transform').$type<number[]>().notNull(), metadata: metadata(),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  unique('scan_revisions_capture_revision_unique').on(t.captureId, t.revision),
  unique('scan_revisions_job_unique').on(t.processingJobId),
  foreignKey({ columns: [t.captureId, t.spaceId], foreignColumns: [captures.id, captures.spaceId], name: 'scan_revisions_capture_space_fk' }),
  foreignKey({ columns: [t.processingJobId, t.captureId], foreignColumns: [processingJobs.id, processingJobs.captureId], name: 'scan_revisions_job_capture_fk' }),
  foreignKey({ columns: [t.scanId, t.spaceId], foreignColumns: [scans.id, scans.spaceId], name: 'scan_revisions_scan_space_fk' }),
  index('scan_revisions_scan_idx').on(t.scanId), index('scan_revisions_space_status_idx').on(t.spaceId, t.status),
  index('scan_revisions_job_idx').on(t.processingJobId),
  check('scan_revisions_number_check', sql`${t.revision} > 0`),
  check('scan_revisions_output_sha256_check', sql`${t.outputSha256} ~ '^[0-9a-f]{64}$'`),
  check('scan_revisions_transform_check', sql`jsonb_typeof(${t.transform}) = 'array' AND jsonb_array_length(${t.transform}) = 16`),
  check('scan_revisions_approval_pair_check', sql`(${t.approvedBy} IS NULL) = (${t.approvedAt} IS NULL)`),
  check('scan_revisions_approval_state_check', sql`(${t.status} IN ('approved', 'superseded') AND ${t.approvedBy} IS NOT NULL) OR (${t.status} IN ('draft', 'rejected') AND ${t.approvedBy} IS NULL)`),
]);
