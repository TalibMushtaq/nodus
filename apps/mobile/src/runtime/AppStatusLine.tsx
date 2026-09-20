// App-wide busy/error/notice line.
//
// The state lives in `useNodusApp`; this renders it in the design language so
// every redesigned screen shows the same feedback instead of the old console's
// bottom line.

import * as React from "react";
import { ActivityIndicator, View } from "react-native";

import { PathIndicator, ThemedText, useTheme } from "../design";
import { ShardProgress } from "../download/ShardProgress";
import { downloadTransportPath } from "../download/transport";
import { useApp } from "./context";

export function AppStatusLine() {
  const { busy, error, notice, downloadProgress, downloadTransport } = useApp();
  const theme = useTheme();
  if (!busy && !error && !notice && !downloadProgress) return null;
  return (
    <View style={{ gap: theme.spacing.xs, marginBottom: theme.spacing.sm }}>
      {downloadProgress ? (
        // Fetch/verify/decrypt stages with the shard-merge animation, so the
        // CPU-bound AEAD pass reads as progress rather than a stall (parity with
        // the web download widget).
        <View style={{ gap: theme.spacing.xs }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
            <ThemedText variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
              {downloadProgress.fileName} · {downloadProgress.phase} · shard{" "}
              {downloadProgress.completedShards}/{downloadProgress.totalShards}
            </ThemedText>
            {downloadTransport ? (
              <PathIndicator path={downloadTransportPath(downloadTransport)} />
            ) : null}
          </View>
          <ShardProgress
            completed={downloadProgress.completedShards}
            total={downloadProgress.totalShards}
            status="active"
          />
        </View>
      ) : null}
      {/* The download row already names the operation, so skip the generic
          "Working…" line while a download is active. */}
      {busy && !downloadProgress ? (
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
