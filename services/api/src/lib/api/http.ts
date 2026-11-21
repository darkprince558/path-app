import { ZodError, type ZodType } from 'zod';
import { connectDatabase } from '../../db/client';
import { requireAuthenticatedUser } from '../auth/current-user';
import { ForbiddenError, UnauthorizedError } from '../auth/errors';
import type { AppUser } from '../auth/user-sync';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export const notFound = () => new ApiError(404, 'NOT_FOUND', 'Resource not found');
export const conflict = (message: string) => new ApiError(409, 'CONFLICT', message);
export const badRequest = (message: string) => new ApiError(400, 'BAD_REQUEST', message);

export async function body<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try { json = await request.json(); } catch { throw badRequest('A JSON body is required'); }
  return schema.parse(json);
}

export async function api(
  request: Request,
  handler: (context: { db: ReturnType<typeof connectDatabase>['db']; user: AppUser | null }) => Promise<Response>,
  optionalAuth = false,
) {
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    let user: AppUser | null;
    try { user = await requireAuthenticatedUser(request); }
    catch (error) {
      if (!optionalAuth || request.headers.has('authorization') || !(error instanceof UnauthorizedError)) throw error;
      user = null;
    }
    connection = connectDatabase();
    return await handler({ db: connection.db, user });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', issues: error.issues } }, { status: 400 });
    }
    if (error instanceof ApiError || error instanceof ForbiddenError || error instanceof UnauthorizedError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    // PostgreSQL constraint failures: never return SQL details to clients.
    if (error && typeof error === 'object' && 'code' in error && ['23503', '23505', '23514'].includes(String(error.code))) {
      return Response.json({ error: { code: 'CONFLICT', message: 'Resource has conflicting references or values' } }, { status: 409 });
    }
    console.error('API request failed', error instanceof Error ? error.message : 'Unknown error');
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, { status: 500 });
  } finally {
    await connection?.client.end();
  }
}

export function signedIn(user: AppUser | null): AppUser {
  if (!user) throw new UnauthorizedError('Authentication required');
  return user;
}
