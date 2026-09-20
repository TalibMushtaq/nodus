// Downloads tab: the in-flight download with a shard-merge animation and its
// transport, plus this device's (account-wide synced) download history.
//
// History reuses the same SQLite transfer log the Activity tab reads — there is
// no second store — so "Clear" stays a single action on Activity.

import * as React from "react";
import { View } from "react-native";
import { formatBytes, formatCountdown, timeAgo } from "@repo/sdk";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import { ShardProgress } from "../download/ShardProgress";
import { downloadMetrics } from "../download/metrics";
import { downloadTransportPath } from "../download/transport";
import { isTransferPath } from "../activity/view";
import {
  Card,
  EmptyState,
  Icon,
  IconButton,
  PathIndicator,
  Screen,
  ScreenHeader,
  ThemedText,
  useTheme,
} from "../design";

export function DownloadsScreen() {
  const app = useApp();
  const theme = useTheme();

  const progress = app.downloadProgress;
  const ratio =
    progress && progress.totalShards > 0
      ? progress.completedShards / progress.totalShards
      : 0;

  // Tick each second so the average throughput/ETA keeps moving between shard
  // completions (the SDK reports bytes per shard, not per chunk).
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!progress) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [progress]);
  const metrics = progress ? downloadMetrics(progress) : null;

  // Refresh the account-wide feed into the local log when the tab opens; the
  // shared `activity` array is the source of truth for history.
  React.useEffect(() => {
    if (app.authed) void app.loadActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.authed]);

  const history = React.useMemo(
    () => app.activity.filter((entry) => entry.kind === "download"),
    [app.activity],
  );

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader
        title="Downloads"
        subtitle={progress ? "Downloading…" : "Active and past downloads"}
      />

      <Screen refreshing={false} onRefresh={() => void app.loadActivity()}>
        <AppStatusLine />

        <ThemedText variant="bodyMedium" style={{ marginBottom: theme.spacing.sm }}>
          Active
        </ThemedText>
        {progress ? (
          <Card style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: theme.spacing.sm,
              }}
            >
              <ThemedText variant="body" numberOfLines={1} style={{ flex: 1 }}>
                {progress.fileName}
              </ThemedText>
              <ThemedText variant="monoSmall" tone="muted">
                {progress.completedShards}/{progress.totalShards}
              </ThemedText>
            </View>
            <ShardProgress
              completed={progress.completedShards}
              total={progress.totalShards}
              status="active"
            />
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
              <ThemedText variant="monoSmall" tone="muted">
                {progress.phase} · {Math.round(ratio * 100)}%
                {metrics && metrics.speedBps > 0 ? ` · ${formatBytes(metrics.speedBps)}/s` : ""}
                {metrics && metrics.etaSeconds != null
                  ? ` · ETA ${formatCountdown(metrics.etaSeconds)}`
                  : ""}
              </ThemedText>
              {app.downloadTransport ? (
                <PathIndicator path={downloadTransportPath(app.downloadTransport)} />
              ) : null}
              <View style={{ marginLeft: "auto" }}>
                <IconButton
                  name="close"
                  size={18}
                  color={theme.colors.mutedForeground}
                  onPress={app.cancelDownload}
                  accessibilityLabel="Cancel download"
                />
              </View>
            </View>
          </Card>
        ) : (
          <EmptyState
            icon="download"
            title="No download in progress"
            description="Downloading a file shows its shard progress and transport here."
          />
        )}

        <ThemedText
          variant="sectionLabel"
          tone="muted"
          style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}
        >
          History
        </ThemedText>

        {history.length === 0 ? (
          <EmptyState
            icon="download"
            title="No downloads yet"
            description="Files you download on this device — or any device on your account — show up here."
          />
        ) : (
          <Card style={{ paddingHorizontal: theme.spacing.md }}>
            {history.map((entry, index) => {
              const failed = entry.outcome === "failed";
              const name =
                entry.fileName ??
                (entry.fileId ? app.fileNames[entry.fileId] : null) ??
                entry.fileId ??
                "File";
              return (
                <React.Fragment key={entry.id}>
                  {index > 0 ? (
                    <View style={{ height: 1, backgroundColor: theme.colors.border, opacity: 0.6 }} />
                  ) : null}
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: theme.spacing.md,
                      paddingVertical: theme.spacing.md,
                    }}
                  >
                    <Icon
                      name="download"
                      size={18}
                      color={failed ? theme.colors.destructive : theme.colors.mutedForeground}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
                        <ThemedText variant="body" numberOfLines={1} style={{ flexShrink: 1 }}>
                          {name}
                        </ThemedText>
                        {isTransferPath(entry.path) ? <PathIndicator path={entry.path} /> : null}
                      </View>
                      <ThemedText variant="monoSmall" tone="muted" numberOfLines={1}>
                        {failed ? "Failed" : "Downloaded"}
                        {entry.detail ? ` · ${entry.detail}` : ""} · {timeAgo(entry.createdAt)}
                      </ThemedText>
                    </View>
                  </View>
                </React.Fragment>
              );
            })}
          </Card>
        )}
      </Screen>
    </View>
  );
}
