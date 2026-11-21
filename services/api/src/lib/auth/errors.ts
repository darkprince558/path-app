export class UnauthorizedError extends Error {
  readonly status = 401;
  readonly code = 'UNAUTHORIZED';
}

export class ForbiddenError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
}
