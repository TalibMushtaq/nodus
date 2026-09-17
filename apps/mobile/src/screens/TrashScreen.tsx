// Trash / deleted items: soft-deleted files and folders awaiting purge or
// restore. Purge is confirmed by the runtime action before it runs.

import * as React from "react";
import { View } from "react-native";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import { Button, Card, Divider, EmptyState, Screen, ThemedText, useTheme } from "../design";

export function TrashScreen() {
  const app = useApp();
  const theme = useTheme();
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    if (app.authed) void app.loadTombstones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.authed]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await app.loadTombstones();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <AppStatusLine />
      <ThemedText variant="caption" tone="muted" style={{ marginBottom: theme.spacing.md }}>
        Deleted items are kept until their retention window ends, then purged from every node.
      </ThemedText>

      {app.tombstones.length === 0 ? (
        <EmptyState icon="trash" title="Nothing deleted" description="Soft-deleted files will appear here." />
      ) : (
        <Card style={{ paddingHorizontal: theme.spacing.md }}>
          {app.tombstones.map((t, index) => (
            <React.Fragment key={`${t.entity_type}:${t.entity_id}`}>
              {index > 0 ? <Divider /> : null}
              <View style={{ paddingVertical: theme.spacing.md, gap: theme.spacing.xs }}>
                <ThemedText variant="body" numberOfLines={1}>
                  {app.tombstoneNames[t.entity_id] ?? `${t.entity_id.slice(0, 12)}…`}
                </ThemedText>
                <ThemedText variant="monoSmall" tone="muted">
                  {t.entity_type} · purges {t.purge_after.slice(0, 10)}
                  {t.purge_requested_at ? " · purging" : ""}
                </ThemedText>
                <View style={{ flexDirection: "row", gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
                  <Button
                    title={app.busy === `restoring-${t.entity_id}` ? "Restoring…" : "Restore"}
                    variant="secondary"
                    onPress={() => void app.restoreTombstone(t)}
                    disabled={app.busy !== null}
                    style={{ flex: 1 }}
                  />
                  <Button
                    title={app.busy === `purging-${t.entity_id}` ? "Deleting…" : "Delete forever"}
                    variant="destructive"
                    onPress={() => app.purgeTombstone(t)}
                    disabled={app.busy !== null}
                    style={{ flex: 1 }}
                  />
                </View>
              </View>
            </React.Fragment>
          ))}
        </Card>
      )}
    </Screen>
  );
}
