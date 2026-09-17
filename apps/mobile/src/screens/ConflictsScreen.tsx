// Conflict inbox (ADR-0003): preserved version forks awaiting resolution.
//
// The Relay exposes a single "mark resolved" operation, so this screen offers
// that one action. The design's Keep A / Keep B choice needs relay + protocol
// work and is tracked separately.

import * as React from "react";
import { View } from "react-native";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import { Button, Card, Divider, EmptyState, Screen, ThemedText, useTheme } from "../design";

export function ConflictsScreen() {
  const { authed, busy, conflicts, loadConflicts, resolveConflict } = useApp();
  const theme = useTheme();

  React.useEffect(() => {
    if (authed) void loadConflicts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  return (
    <Screen>
      <AppStatusLine />
      <ThemedText variant="caption" tone="muted" style={{ marginBottom: theme.spacing.md }}>
        A conflicted copy is kept as a sibling file rather than overwriting either version.
      </ThemedText>

      {conflicts.length === 0 ? (
        <EmptyState
          icon="statusConflict"
          title="No unresolved conflicts"
          description="When two devices edit the same file, the preserved copy will appear here."
        />
      ) : (
        <Card style={{ paddingHorizontal: theme.spacing.md }}>
          {conflicts.map((c, index) => (
            <React.Fragment key={c.fileId}>
              {index > 0 ? <Divider /> : null}
              <View style={{ paddingVertical: theme.spacing.md, gap: theme.spacing.xs }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
                  <ThemedText variant="body" style={{ flex: 1 }} numberOfLines={1}>
                    {c.name}
                  </ThemedText>
                  <View
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 2,
                      borderRadius: theme.radius.full,
                      backgroundColor: theme.status.conflictBg,
                      borderWidth: 1,
                      borderColor: `${theme.status.conflict}30`,
                    }}
                  >
                    <ThemedText variant="monoSmall" style={{ color: theme.status.conflict }}>
                      Conflicted
                    </ThemedText>
                  </View>
                </View>
                <ThemedText variant="monoSmall" tone="muted">
                  {c.versions.map((v) => `v${v}`).join(", ")} · {c.fileId.slice(0, 12)}…
                </ThemedText>
                {c.siblingName ? (
                  <ThemedText variant="caption" tone="muted">
                    Preserved as {c.siblingName}
                  </ThemedText>
                ) : null}
                {c.versions.length >= 2 ? (
                  <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
                    <View style={{ flexDirection: "row", gap: theme.spacing.sm }}>
                      <Button
                        title={`Keep v${c.versions[0]}`}
                        variant="secondary"
                        onPress={() => void resolveConflict(c.fileId, c.versions[0])}
                        disabled={busy !== null}
                        style={{ flex: 1 }}
                      />
                      <Button
                        title={`Keep v${c.versions[c.versions.length - 1]}`}
                        variant="secondary"
                        onPress={() => void resolveConflict(c.fileId, c.versions[c.versions.length - 1])}
                        disabled={busy !== null}
                        style={{ flex: 1 }}
                      />
                    </View>
                    <Button
                      title={busy === `resolving-${c.fileId}` ? "Resolving…" : "Keep both (preserve copy)"}
                      onPress={() => void resolveConflict(c.fileId)}
                      disabled={busy !== null}
                    />
                  </View>
                ) : (
                  <Button
                    title={busy === `resolving-${c.fileId}` ? "Resolving…" : "Mark resolved"}
                    variant="secondary"
                    onPress={() => void resolveConflict(c.fileId)}
                    disabled={busy !== null}
                    style={{ marginTop: theme.spacing.sm }}
                  />
                )}
              </View>
            </React.Fragment>
          ))}
        </Card>
      )}
    </Screen>
  );
}
