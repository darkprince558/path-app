import { eq, and } from 'drizzle-orm';
import { connectDatabase } from '../../db/client';
import { eventMembers, events } from '../../db/schema';
import type { AppUser } from './user-sync';
import { ForbiddenError } from './errors';

export function requireOwner(user: AppUser, ownerId: string) {
  if (user.id !== ownerId) throw new ForbiddenError('Owner access required');
}

export async function requireEventMember(user: AppUser, eventId: string) {
  const { db, client } = connectDatabase();
  try {
    const [event] = await db.select({ ownerId: events.ownerId }).from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) throw new ForbiddenError('Event membership required');
    if (event.ownerId === user.id) return;
    const [member] = await db.select({ role: eventMembers.role }).from(eventMembers)
      .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, user.id))).limit(1);
    if (!member) throw new ForbiddenError('Event membership required');
  } finally {
    await client.end();
  }
}
