export function auth0Audience() {
  const audience = process.env.AUTH0_AUDIENCE;
  if (!audience || !URL.canParse(audience)) {
    throw new Error('AUTH0_AUDIENCE must be an absolute URL matching the Auth0 API identifier');
  }
  return audience;
}

export function auth0Issuer() {
  const domain = process.env.AUTH0_DOMAIN;
  if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) {
    throw new Error('AUTH0_DOMAIN must be a hostname');
  }
  return `https://${domain}/`;
}
