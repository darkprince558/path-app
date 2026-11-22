/** Same-origin session cookies stay in the browser; tokens never enter React. */
export const SESSION_EXPIRED = "path:session-expired";

export function reportUnauthorized(status: number) {
  if (status === 401) window.dispatchEvent(new Event(SESSION_EXPIRED));
}

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...options, credentials: "same-origin", cache: "no-store" });
  if (!options.signal?.aborted) reportUnauthorized(response.status);
  return response;
}

export function loginHref(returnTo = "/maps") {
  // Only local application paths can become a post-login destination.
  const target = returnTo.startsWith("/") && !returnTo.startsWith("//") && !returnTo.includes("\\")
    && !/^\/auth(?:[/?#]|$)/.test(returnTo) ? returnTo : "/maps";
  return `/auth/login?${new URLSearchParams({ returnTo: target })}`;
}
