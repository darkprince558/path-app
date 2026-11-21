import { sql } from 'drizzle-orm';
import { connectDatabase } from './client.js';

const { db, client } = connectDatabase();
try {
  await db.execute(sql`select 1`);
  console.log('Database connection OK');
} finally {
  await client.end();
}
