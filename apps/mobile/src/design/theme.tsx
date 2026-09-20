// Theme + font loading for the Nodus mobile app.
//
// The prototype ships a light and a dark palette; the user can pick either or
// follow the OS. The choice is persisted in the non-secret SQLite preferences
// store (not the keychain) so it survives restarts without touching auth state.

import * as React from "react";
import { useColorScheme } from "react-native";
import { useFonts } from "expo-font";
// Import each weight from its own subpath: the package root re-exports every
// weight and style, which would bundle ~18 unused font files into the app.
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_500Medium } from "@expo-google-fonts/inter/500Medium";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { Inter_700Bold } from "@expo-google-fonts/inter/700Bold";
import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono/400Regular";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono/500Medium";

import { getPreference, setPreference } from "../store/preferences";
import { buildTheme, type ColorScheme, type Theme } from "./tokens";

export type ThemeMode = "light" | "dark" | "system";

const THEME_PREF_KEY = "theme";

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  theme: Theme;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = React.useState<ThemeMode>("system");

  // Hydrate the persisted choice once. Until it resolves we follow the OS,
  // which is also the default, so there is no visible flash for new installs.
  // A read failure (e.g. a DB that is not ready yet) must not reject
  // unhandled: the app keeps following the OS until the next launch.
  React.useEffect(() => {
    let cancelled = false;
    void getPreference(THEME_PREF_KEY)
      .then((stored) => {
        if (!cancelled && isThemeMode(stored)) setModeState(stored);
      })
      .catch(() => {
        // Fall back to the OS-following default; persistence resumes on the
        // next successful write.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = React.useCallback((next: ThemeMode) => {
    setModeState(next);
    // Fire-and-forget: a failed write only means the next launch reverts to
    // the previous preference, which is not worth blocking the UI for.
    void setPreference(THEME_PREF_KEY, next);
  }, []);

  // `useColorScheme()` can return null/undefined/"unspecified" depending on
  // platform; anything that is not explicitly dark follows the light palette.
  const resolvedSystem: ColorScheme = systemScheme === "dark" ? "dark" : "light";
  const scheme: ColorScheme = mode === "system" ? resolvedSystem : mode;
  const theme = React.useMemo(() => buildTheme(scheme), [scheme]);
  const value = React.useMemo(() => ({ mode, setMode, theme }), [mode, setMode, theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx.theme;
}

export function useThemeMode(): Pick<ThemeContextValue, "mode" | "setMode"> {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useThemeMode must be used within ThemeProvider");
  return { mode: ctx.mode, setMode: ctx.setMode };
}

/**
 * Load the two typefaces the design specifies. Resolves to `true` when ready
 * (or when loading failed), so a font error degrades to system fonts instead
 * of blocking the app forever.
 */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });
  return loaded || error != null;
}
