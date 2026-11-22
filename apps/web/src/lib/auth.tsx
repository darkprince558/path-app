import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { loginHref, SESSION_EXPIRED } from "./http.ts";

export interface SessionUser { id: string; displayName: string }
type AuthState = { status: "loading" | "authenticated" | "anonymous" | "error"; user: SessionUser | null };
const AuthContext = createContext<(AuthState & { refresh: () => Promise<void> }) | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading", user: null });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const attempt = ++generation.current;
    try {
      const response = await fetch("/api/users/me", { credentials: "same-origin", cache: "no-store" });
      if (attempt !== generation.current) return;
      if (response.status === 401) { setState({ status: "anonymous", user: null }); return; }
      if (!response.ok) throw new Error("Account unavailable");
      const { user } = await response.json() as { user: SessionUser };
      if (!user || typeof user.id !== "string" || typeof user.displayName !== "string") throw new Error("Invalid account");
      if (attempt === generation.current) setState({ status: "authenticated", user });
    } catch {
      if (attempt === generation.current) setState({ status: "error", user: null });
    }
  }, []);
  useEffect(() => {
    void refresh();
    const expired = () => { ++generation.current; setState({ status: "anonymous", user: null }); };
    const focus = () => { void refresh(); };
    window.addEventListener(SESSION_EXPIRED, expired);
    window.addEventListener("focus", focus);
    return () => { ++generation.current; window.removeEventListener(SESSION_EXPIRED, expired); window.removeEventListener("focus", focus); };
  }, [refresh]);
  return <AuthContext.Provider value={{ ...state, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth requires AuthProvider");
  return auth;
}

/** `className` adds layout for where it sits, e.g. the sidebar spreads the name and Sign out apart. */
export function AccountControls({ className = "" }: { className?: string } = {}) {
  const { status, user, refresh } = useAuth();
  const location = useLocation();
  if (status === "loading") return <span role="status">Checking sign-in…</span>;
  if (status === "error") return <button onClick={() => void refresh()} className="underline">Retry sign-in check</button>;
  return user ? <div className={`flex flex-wrap items-center gap-x-6 gap-y-1 ${className}`}><span className="min-w-0 truncate">{user.displayName}</span><a className="inline-flex min-h-11 shrink-0 items-center underline underline-offset-4" href="/auth/logout?returnTo=%2F">Sign out</a></div>
    : <a className="underline" href={loginHref(location.pathname === "/" ? "/maps" : location.pathname + location.search + location.hash)}>Sign in</a>;
}

export function RequireAuth() {
  const { status, user, refresh } = useAuth();
  const location = useLocation();
  if (status === "loading") return <p role="status">Checking sign-in…</p>;
  if (status === "error") return <div role="alert"><p>Couldn’t check your account. Try again.</p><button className="underline" onClick={() => void refresh()}>Retry</button></div>;
  if (!user) return <section className="space-y-4"><h1 className="text-2xl font-bold">Sign in to manage your maps</h1><p>Your session may have ended. Sign in to continue.</p><a className="action-button" href={loginHref(location.pathname + location.search + location.hash)}>Sign in</a></section>;
  return <Outlet key={user.id} />;
}
