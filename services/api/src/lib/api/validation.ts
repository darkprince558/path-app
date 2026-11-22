import { z } from 'zod';

export const uuid = z.uuid();
export const name = z.string().trim().min(1).max(200);
export const description = z.string().trim().max(4000).nullable().optional();
export const visibility = z.enum(['private', 'public']);
export const metadata = z.record(z.string(), z.unknown());
export const boundary = z.record(z.string(), z.unknown()).nullable().optional();
export const node = z.object({
  x: z.number().finite(), y: z.number().finite(), z: z.number().finite(),
  floor: z.number().int().nullable().optional(), metadata: metadata.optional(),
}).strict();
export const edge = z.object({
  fromNodeId: uuid, toNodeId: uuid, distance: z.number().finite().positive(),
  accessible: z.boolean().optional(), bidirectional: z.boolean().optional(), metadata: metadata.optional(),
}).strict().refine(v => v.fromNodeId !== v.toNodeId, 'An edge must connect distinct nodes');
export const spaceInput = z.object({ name, description, visibility: visibility.optional(), boundary }).strict();
export const destinationInput = z.object({ spaceId: uuid, nodeId: uuid, name, description, category: z.string().trim().max(100).nullable().optional() }).strict();
export const pathInput = z.object({
  spaceId: uuid, name, description, visibility: visibility.optional(),
  nodeIds: z.array(uuid).min(2).max(1000),
}).strict();
export const eventInput = z.object({
  name, description, visibility: visibility.optional(),
  spaceIds: z.array(uuid).max(100).default([]),
  pathIds: z.array(uuid).max(100).default([]),
  destinationIds: z.array(uuid).max(200).default([]),
}).strict();
