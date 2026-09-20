// App-wide busy/error/notice line.
//
// The state lives in `useNodusApp`; this renders it in the design language so
// every redesigned screen shows the same feedback instead of the old console's
// bottom line.

import * as React from "react";
import { ActivityIndicator, View } from "react-native";
import { formatBytes, formatCountdown } from "@repo/sdk";

import { IconButton, PathIndicator, ThemedText, useTheme } from "../design";
import { ShardProgress } from "../download/ShardProgress";
import { downloadMetrics } from "../download/metrics";
import { downloadTransportPath } from "../download/transport";
import { useApp } from "./context";

export function AppStatusLine() {
  const { busy, error, notice, downloadProgress, downloadTransport, cancelDownload } = useApp();
  const theme = useTheme();

  // Bytes arrive once per shard, so tick each second to keep the throughput/ETA
  // readout moving between shard completions. Hook runs above the early return
  // so the hook order stays stable when the line is hidden.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!downloadProgress) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [downloadProgress]);

  if (!busy && !error && !notice && !downloadProgress) return null;
  const metrics = downloadProgress ? downloadMetrics(downloadProgress) : null;
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
            <IconButton
              name="close"
              size={16}
              color={theme.colors.mutedForeground}
              onPress={cancelDownload}
              accessibilityLabel="Cancel download"
            />
          </View>
          {metrics && metrics.speedBps > 0 ? (
            <ThemedText variant="caption" tone="muted" numberOfLines={1}>
              {formatBytes(metrics.speedBps)}/s
              {metrics.etaSeconds != null ? ` · ETA ${formatCountdown(metrics.etaSeconds)}` : ""}
            </ThemedText>
          ) : null}
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
