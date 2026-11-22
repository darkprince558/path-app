/** Same-origin session cookies stay in the browser; tokens never enter React. */
export const SESSION_EXPIRED = "path:session-expired";

export function reportUnauthorized(status: number) {
  if (status === 401) window.dispatchEvent(new Event(SESSION_EXPIRED));
}

/**
 * API responses are never stored by default. Large map files opt in with `cache: "no-cache"`:
 * the browser keeps them and revalidates each time (the server answers 304 when unchanged,
 * after its normal access check).
 */
export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { cache: "no-store", ...options, credentials: "same-origin" });
  if (!options.signal?.aborted) reportUnauthorized(response.status);
  return response;
}

export function loginHref(returnTo = "/maps") {
  // Only local application paths can become a post-login destination.
  const target = returnTo.startsWith("/") && !returnTo.startsWith("//") && !returnTo.includes("\\")
    && !/^\/auth(?:[/?#]|$)/.test(returnTo) ? returnTo : "/maps";
  return `/auth/login?${new URLSearchParams({ returnTo: target })}`;
}
