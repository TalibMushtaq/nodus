// Activity tab: live upload progress plus the device-local activity log.
//
// The Relay exposes no account-wide activity feed, so — like the web client —
// this is this device's own history of terminal outcomes, read from the SQLite
// `transfer_log` store. Filters mirror the design's chip row.

import * as React from "react";
import { View } from "react-native";
import { timeAgo } from "@repo/sdk";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import {
  ACTIVITY_FILTERS,
  KIND_META,
  filterActivity,
  isTransferPath,
  type ActivityFilter,
} from "../activity/view";
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  Icon,
  PathIndicator,
  Progress,
  Screen,
  ScreenHeader,
  ThemedText,
  useTheme,
} from "../design";

export function ActivityScreen() {
  const app = useApp();
  const theme = useTheme();
  const [filter, setFilter] = React.useState<ActivityFilter>("All");
  const [confirmClear, setConfirmClear] = React.useState(false);

  const entries = React.useMemo(
    () => filterActivity(app.activity, filter),
    [app.activity, filter],
  );

  const progress = app.uploadProgress;
  const progressRatio = progress && progress.totalBytes > 0 ? progress.completedBytes / progress.totalBytes : 0;

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader
        title="Activity"
        subtitle={
          app.pendingTransfers > 0
            ? `${app.pendingTransfers} transfer${app.pendingTransfers === 1 ? "" : "s"} in flight`
            : "Live transfers and sync events"
        }
        right={
          app.activity.length > 0 ? (
            <Button
              title="Clear"
              variant="ghost"
              onPress={() => setConfirmClear(true)}
              style={{ paddingHorizontal: theme.spacing.sm, paddingVertical: theme.spacing.xs }}
            />
          ) : undefined
        }
      />

      <View>
        <View
          style={{
            flexDirection: "row",
            gap: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
            flexWrap: "wrap",
          }}
        >
          {ACTIVITY_FILTERS.map((f) => (
            <Chip key={f} label={f} active={filter === f} onPress={() => setFilter(f)} />
          ))}
        </View>
      </View>

      <Screen refreshing={false} onRefresh={() => void app.loadActivity()}>
        <AppStatusLine />

        <ThemedText variant="bodyMedium" style={{ marginBottom: theme.spacing.sm }}>
          Live transfers
        </ThemedText>
        {progress ? (
          <Card style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.spacing.sm }}>
              <ThemedText variant="body" numberOfLines={1} style={{ flex: 1 }}>
                {progress.fileName}
              </ThemedText>
              <ThemedText variant="monoSmall" tone="muted">
                {progress.completedShards}/{progress.totalShards}
              </ThemedText>
            </View>
            <Progress value={progressRatio} tone={theme.status.pending} />
            <ThemedText variant="monoSmall" tone="muted">
              {progress.phase} · {Math.round(progressRatio * 100)}%
            </ThemedText>
          </Card>
        ) : (
          <EmptyState
            icon="activity"
            title="No transfer in progress"
            description="Uploads in flight show up here with byte progress."
          />
        )}

        <ThemedText
          variant="sectionLabel"
          tone="muted"
          style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}
        >
          Sync history
        </ThemedText>

        {entries.length === 0 ? (
          <EmptyState
            icon="clock"
            title={app.activity.length === 0 ? "No activity yet" : "Nothing matches this filter"}
            description="Uploads, downloads, renames, deletes and conflict resolutions are recorded on this device."
          />
        ) : (
          <Card style={{ paddingHorizontal: theme.spacing.md }}>
            {entries.map((entry, index) => {
              const meta = KIND_META[entry.kind];
              const failed = entry.outcome === "failed";
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
                      name={meta.icon}
                      size={18}
                      color={failed ? theme.colors.destructive : theme.colors.mutedForeground}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
                        <ThemedText variant="body" numberOfLines={1} style={{ flexShrink: 1 }}>
                          {entry.fileName ?? entry.fileId ?? meta.label}
                        </ThemedText>
                        {isTransferPath(entry.path) ? <PathIndicator path={entry.path} /> : null}
                      </View>
                      <ThemedText variant="monoSmall" tone="muted">
                        {failed ? "Failed" : meta.label}
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

      <ConfirmDialog
        visible={confirmClear}
        title="Clear activity log?"
        message="This removes this device's local history. It does not affect your files."
        confirmLabel="Clear"
        destructive
        onConfirm={() => {
          setConfirmClear(false);
          void app.clearActivity();
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </View>
  );
}
