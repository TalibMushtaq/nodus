"use client";

/* eslint-disable react-hooks/set-state-in-effect --
   This provider deliberately syncs React state to localStorage + the DOM
   inside effects: the theme must hydrate from the browser-only store after
   SSR without flashing. That is the one place this rule's "avoid setState
   in effects" advice does not apply. */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  resolvedDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

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

  // Hydrate the saved preference after mount; SSR renders with system default
  // and a tiny inline script in layout.tsx pre-applies the class to avoid FOUC.
  useEffect(() => {
    const saved = localStorage.getItem("nodus.theme") as Theme | null;
    if (saved === "light" || saved === "dark" || saved === "system") {
      setTheme(saved);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("nodus.theme", theme);
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