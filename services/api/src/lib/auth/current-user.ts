import { errors } from 'jose';
import { auth0 } from '../auth0';
import { auth0Audience } from './config';
import { UnauthorizedError } from './errors';
import { verifyAccessToken } from './token';
import { syncAuth0User, type AppUser } from './user-sync';

function bearerToken(request: Request) {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  if (!match) throw new UnauthorizedError('A valid bearer token is required');
  return match[1];
}

export async function requireAuthenticatedUser(request: Request): Promise<AppUser> {
  let token = bearerToken(request);
  let sessionSub: string | undefined;
  let sessionName: string | undefined;

  if (token === null) {
    const session = await auth0.getSession();
    if (!session?.user.sub) throw new UnauthorizedError('Authentication required');
    sessionSub = session.user.sub;
    sessionName = session.user.name;
    try {
      token = (await auth0.getAccessToken({ audience: auth0Audience() })).token;
    } catch {
      throw new UnauthorizedError('An API access token is required');
    }
  }

  let claims: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    claims = await verifyAccessToken(token);
  } catch (error) {
    if (error instanceof errors.JOSEError || (error instanceof Error && error.message === 'Access token has no subject')) {
      throw new UnauthorizedError('Invalid access token');
    }
    throw error;
  }
  const sub = claims.sub;
  if (sessionSub && sessionSub !== sub) throw new UnauthorizedError('Session does not match access token');

  const claimedName = typeof claims.name === 'string' ? claims.name : undefined;
  return syncAuth0User(sub, sessionName || claimedName);
}
