// Nodus mobile design tokens.
//
// Ported from the Figma prototype (`nodus-design/src/index.css`) so the native
// app speaks the same visual language as the web client. Centralising every
// color/size here means screens never hardcode palette values, and the dark
// palette stays a deliberate second mood rather than an inversion.

export type ColorScheme = "light" | "dark";

/** Semantic surface/text/border colors. */
export interface Palette {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

/** Sync/connection status palette (the product's core visual vocabulary). */
export interface StatusPalette {
  synced: string;
  syncedBg: string;
  pending: string;
  pendingBg: string;
  conflict: string;
  conflictBg: string;
  offline: string;
  offlineBg: string;
  local: string;
  localBg: string;
}

export const lightPalette: Palette = {
  background: "#F7F5F2",
  foreground: "#1C1A17",
  card: "#FFFFFF",
  cardForeground: "#1C1A17",
  primary: "#1C1A17",
  primaryForeground: "#F7F5F2",
  secondary: "#EDEBE6",
  secondaryForeground: "#1C1A17",
  muted: "#EDEBE6",
  mutedForeground: "#78746E",
  accent: "#B85C1A",
  accentForeground: "#FFFFFF",
  destructive: "#C0442B",
  destructiveForeground: "#FFFFFF",
  border: "#DDD9D3",
  input: "#DDD9D3",
  ring: "#B85C1A",
};

export const darkPalette: Palette = {
  background: "#141210",
  foreground: "#EDE9E2",
  card: "#1E1C19",
  cardForeground: "#EDE9E2",
  primary: "#EDE9E2",
  primaryForeground: "#141210",
  secondary: "#252320",
  secondaryForeground: "#EDE9E2",
  muted: "#252320",
  mutedForeground: "#857F78",
  accent: "#C8722A",
  accentForeground: "#FFFFFF",
  destructive: "#C05535",
  destructiveForeground: "#FFFFFF",
  border: "#2A2824",
  input: "#2A2824",
  ring: "#C8722A",
};

export const lightStatus: StatusPalette = {
  synced: "#1D7A45",
  syncedBg: "#D6F0E3",
  pending: "#B85C1A",
  pendingBg: "#FDEBD6",
  conflict: "#B33A22",
  conflictBg: "#FCE0DA",
  offline: "#6B6560",
  offlineBg: "#E8E6E2",
  local: "#2E5F8A",
  localBg: "#D6E8F8",
};

export const darkStatus: StatusPalette = {
  synced: "#34C472",
  syncedBg: "#0F2E1C",
  pending: "#E07830",
  pendingBg: "#2E1A08",
  conflict: "#E0604A",
  conflictBg: "#2E100C",
  offline: "#908A83",
  offlineBg: "#1C1B18",
  local: "#4FA0D4",
  localBg: "#0C1E2C",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

// The prototype uses near-square corners on mobile (2px) and only rounds
// pills/badges fully; keeping that crispness is part of the identity.
export const radius = {
  sm: 2,
  md: 6,
  lg: 10,
  full: 999,
} as const;

// Font family names are the keys passed to `useFonts`, so they must match the
// loaded asset map in `theme.tsx`.
export const fonts = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  mono: "JetBrainsMono_400Regular",
  monoMedium: "JetBrainsMono_500Medium",
} as const;

export const fontSize = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 18,
  xl: 22,
} as const;

/** The resolved theme handed to every component through `useTheme()`. */
export interface Theme {
  scheme: ColorScheme;
  dark: boolean;
  colors: Palette;
  status: StatusPalette;
  spacing: typeof spacing;
  radius: typeof radius;
  fonts: typeof fonts;
  fontSize: typeof fontSize;
}

/** Assemble a theme from a resolved scheme. */
export function buildTheme(scheme: ColorScheme): Theme {
  const dark = scheme === "dark";
  return {
    scheme,
    dark,
    colors: dark ? darkPalette : lightPalette,
    status: dark ? darkStatus : lightStatus,
    spacing,
    radius,
    fonts,
    fontSize,
  };
}
