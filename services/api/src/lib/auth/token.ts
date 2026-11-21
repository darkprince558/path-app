import {
  createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload,
} from 'jose';
import { auth0Audience, auth0Issuer } from './config';

let remoteKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function verifyTokenWithKeys(
  token: string,
  keys: JWTVerifyGetKey,
  issuer: string,
): Promise<JWTPayload & { sub: string }> {
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience: auth0Audience(),
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp'],
  });
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('Access token has no subject');
  }
  return payload as JWTPayload & { sub: string };
}

export function verifyAccessToken(token: string) {
  const issuer = auth0Issuer();
  remoteKeys ??= createRemoteJWKSet(new URL('.well-known/jwks.json', issuer));
  return verifyTokenWithKeys(token, remoteKeys, issuer);
}
