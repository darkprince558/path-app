/**
 * Who is signed in. There is no real sign-in yet (the hosted login is a later
 * decision, see docs/deployment.md), so development uses a stand-in account:
 * VITE_DEV_USER is the ID the local scan mock trusts, VITE_DEV_NAME is the label shown.
 */
export interface SessionUser {
  id: string;
  name: string;
  initials: string;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]?.[0], parts[parts.length - 1]?.[0]] : [parts[0]?.[0]];
  return letters.join("").toUpperCase() || "?";
}

export function currentUser(): SessionUser {
  const id = import.meta.env.VITE_DEV_USER || "demo-owner";
  const name = import.meta.env.VITE_DEV_NAME || "Demo owner";
  return { id, name, initials: initialsOf(name) };
}
