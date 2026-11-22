import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Accessibility and comfort settings, kept on this device (no account needed, so
 * guests can use them too). Saved with localStorage. If storage is blocked
 * (private browsing), the settings still work for this visit.
 */
export type TextSize = "default" | "large" | "xlarge";
export type MotionPreference = "system" | "reduce" | "full";

export interface Preferences {
  textSize: TextSize;
  motion: MotionPreference;
  /** Default for the per-trip "Avoid stairs" switch on a map. */
  avoidStairs: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { textSize: "default", motion: "system", avoidStairs: false };

const STORAGE_KEY = "path.preferences.v1";

/** Root font size for each text size. Everything is sized in rem, so the whole UI scales. */
export const TEXT_SCALE: Record<TextSize, string> = { default: "100%", large: "118.75%", xlarge: "137.5%" };

function load(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const saved = JSON.parse(raw) as Partial<Preferences>;
    return {
      textSize: saved.textSize && saved.textSize in TEXT_SCALE ? saved.textSize : DEFAULT_PREFERENCES.textSize,
      motion: saved.motion === "reduce" || saved.motion === "full" ? saved.motion : "system",
      avoidStairs: saved.avoidStairs === true,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function save(preferences: Preferences) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage unavailable: keep the in-memory value for this visit.
  }
}

/** Puts the settings on <html> so CSS can react: font size and data-motion. */
function apply(preferences: Preferences) {
  const root = document.documentElement;
  root.style.fontSize = TEXT_SCALE[preferences.textSize];
  root.dataset.textSize = preferences.textSize;
  root.dataset.motion = preferences.motion;
}

interface PreferencesContext {
  preferences: Preferences;
  update: (change: Partial<Preferences>) => void;
}

const Context = createContext<PreferencesContext | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(load);

  useEffect(() => apply(preferences), [preferences]);

  // Another tab changed the settings: follow it.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setPreferences(load());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((change: Partial<Preferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...change };
      save(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ preferences, update }), [preferences, update]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePreferences(): PreferencesContext {
  const value = useContext(Context);
  if (!value) throw new Error("usePreferences must be used inside PreferencesProvider");
  return value;
}

/** True when motion should be reduced: the user chose it, or chose "match my device" and the device asks for it. */
export function useReducedMotion(): boolean {
  const { preferences } = usePreferences();
  const [systemReduce, setSystemReduce] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setSystemReduce(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  if (preferences.motion === "reduce") return true;
  if (preferences.motion === "full") return false;
  return systemReduce;
}

/**
 * The "Avoid stairs" choice for one trip on one map. It starts from the saved default
 * and changing it doesn't touch the default, so someone walking with a friend who uses
 * a wheelchair (or who is just tired) can switch it on for this trip only. It lasts
 * for this browser tab, so a reload keeps the choice.
 */
export function useTripAvoidStairs(shareId: string): [boolean, (value: boolean) => void] {
  const { preferences } = usePreferences();
  const key = `path.trip.avoidStairs.${shareId}`;
  const [value, setValue] = useState<boolean>(() => {
    try {
      const saved = sessionStorage.getItem(key);
      if (saved === "true" || saved === "false") return saved === "true";
    } catch {
      // ignore
    }
    return preferences.avoidStairs;
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        sessionStorage.setItem(key, String(next));
      } catch {
        // ignore
      }
    },
    [key],
  );
  return [value, set];
}
