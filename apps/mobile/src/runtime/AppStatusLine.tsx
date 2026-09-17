// App-wide busy/error/notice line.
//
// The state lives in `useNodusApp`; this renders it in the design language so
// every redesigned screen shows the same feedback instead of the old console's
// bottom line.

import * as React from "react";
import { ActivityIndicator, View } from "react-native";

import { ThemedText, useTheme } from "../design";
import { useApp } from "./context";

export function AppStatusLine() {
  const { busy, error, notice } = useApp();
  const theme = useTheme();
  if (!busy && !error && !notice) return null;
  return (
    <View style={{ gap: theme.spacing.xs, marginBottom: theme.spacing.sm }}>
      {busy ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
          <ActivityIndicator size="small" color={theme.colors.mutedForeground} />
          <ThemedText variant="caption" tone="muted">
            Working… ({busy})
          </ThemedText>
        </View>
      ) : null}
      {error ? (
        <ThemedText variant="caption" tone="destructive">
          {error}
        </ThemedText>
      ) : null}
      {notice && !error ? (
        <ThemedText variant="caption" tone="accent">
          {notice}
        </ThemedText>
      ) : null}
    </View>
  );
}
