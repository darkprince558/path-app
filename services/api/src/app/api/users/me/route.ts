import { requireAuthenticatedUser } from '../../../../lib/auth/current-user';
import { UnauthorizedError } from '../../../../lib/auth/errors';

export async function GET(request: Request) {
  try {
    const user = await requireAuthenticatedUser(request);
    return Response.json({ user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
