import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyTokenWithKeys } from './token';

const issuer = 'https://auth.example.test/';
const audience = 'https://api.not404.app';

test('accepts only a signed, unexpired token for our issuer and audience', async (t) => {
  const previousAudience = process.env.AUTH0_AUDIENCE;
  process.env.AUTH0_AUDIENCE = audience;
  t.after(() => {
    if (previousAudience === undefined) delete process.env.AUTH0_AUDIENCE;
    else process.env.AUTH0_AUDIENCE = previousAudience;
  });
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'one', use: 'sig' }] });
  const sign = (overrides: { issuer?: string; audience?: string; expiresAt?: number } = {}) =>
    new SignJWT({ sub: 'auth0|user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'one' })
      .setIssuer(overrides.issuer ?? issuer)
      .setAudience(overrides.audience ?? audience)
      .setExpirationTime(overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 300)
      .sign(privateKey);

  assert.equal((await verifyTokenWithKeys(await sign(), keys, issuer)).sub, 'auth0|user-1');
  await assert.rejects(verifyTokenWithKeys(await sign({ issuer: 'https://other.example.test/' }), keys, issuer));
  await assert.rejects(verifyTokenWithKeys(await sign({ audience: 'https://other-api' }), keys, issuer));
  await assert.rejects(verifyTokenWithKeys(await sign({ expiresAt: Math.floor(Date.now() / 1000) - 60 }), keys, issuer));

  const otherKey = (await generateKeyPair('RS256')).privateKey;
  const forged = await new SignJWT({ sub: 'auth0|user-1' })
    .setProtectedHeader({ alg: 'RS256', kid: 'one' })
    .setIssuer(issuer).setAudience(audience).setExpirationTime('5m').sign(otherKey);
  await assert.rejects(verifyTokenWithKeys(forged, keys, issuer));
});
