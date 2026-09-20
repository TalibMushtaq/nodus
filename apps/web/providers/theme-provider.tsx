"use client";

// The theme must hydrate from the browser-only store after SSR without
// flashing, so this provider deliberately reads localStorage and syncs state +
// the DOM class inside one mount effect.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

export type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  resolvedDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Storage key, also read by the pre-hydration inline script in layout.tsx. */
export const THEME_STORAGE_KEY = "nodus.theme";

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(t: Theme): boolean {
  const dark = t === "dark" || (t === "system" && prefersDark());
  document.documentElement.classList.toggle("dark", dark);
  return dark;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("system");
  const [resolvedDark, setResolvedDark] = useState(false);
  // Separates the first (hydrating) effect run from later user-driven changes.
  // Without it the persisted value is overwritten by the SSR default on every
  // mount: the old code wrote "system" before the hydrate effect could read the
  // saved choice, so a saved dark/light could be clobbered (and briefly
  // un-applied, flashing light).
  const hydrated = useRef(false);

  // Hydrate from storage and apply, or persist + apply a later change. A single
  // effect keeps the read and the write ordered so the stored value is never
  // overwritten before it is read.
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      const next = isTheme(saved) ? saved : "system";
      setTheme(next);
      // The inline script already set the class pre-paint; re-applying keeps
      // state and DOM in sync without a default-mode flash.
      setResolvedDark(applyTheme(next));
      return;
    }
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    setResolvedDark(applyTheme(theme));
  }, [theme]);

  // In "system" mode, follow OS changes live (e.g. night-light schedule).
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolvedDark(applyTheme("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme, resolvedDark }), [theme, resolvedDark]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}