import { createHash } from 'node:crypto';
import { connectDatabase } from '../../db/client';
import { users } from '../../db/schema';

export type AppUser = typeof users.$inferSelect;

export async function syncAuth0User(sub: string, name?: string): Promise<AppUser> {
  // API access tokens need not carry profile claims. Keep the username stable from sub.
  const suffix = createHash('sha256').update(sub).digest('hex').slice(0, 24);
  const username = `auth0_${suffix}`;
  const displayName = name?.trim().slice(0, 255) || username;
  const { db, client } = connectDatabase();
  try {
    const [user] = await db.insert(users)
      .values({ auth0Sub: sub, username, displayName })
      .onConflictDoUpdate({ target: users.auth0Sub, set: {
        updatedAt: new Date(),
        ...(displayName !== username ? { displayName } : {}),
      } })
      .returning();
    return user;
  } finally {
    await client.end();
  }
}
