import { Auth0Client } from '@auth0/nextjs-auth0/server';
import { auth0Audience } from './auth/config';

export const auth0 = new Auth0Client({
  authorizationParameters: { audience: auth0Audience() },
  enableAccessTokenEndpoint: false,
});
