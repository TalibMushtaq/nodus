// Storage-node detail: rename, identity fingerprint, capacity, and a manual
// ping. Set-primary and forget-node need relay/store support and are deferred.

import * as React from "react";
import { View } from "react-native";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { formatBytes, timeAgo } from "@repo/sdk";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import {
  Button,
  Card,
  ConfirmDialog,
  Divider,
  EmptyState,
  Progress,
  Screen,
  StatusBadge,
  TextField,
  ThemedText,
  useTheme,
} from "../design";
import type { DevicesStackParamList } from "../navigation/types";

export function NodeDetailScreen() {
  const app = useApp();
  const theme = useTheme();
  const route = useRoute<RouteProp<DevicesStackParamList, "NodeDetail">>();
  const node = app.nodes.find((n) => n.node_id === route.params.nodeId);
  const [confirmUnpair, setConfirmUnpair] = React.useState(false);
  const isTrusted = app.trusted.some((t) => t.node_id === route.params.nodeId);

  // Rename reuses the shared inline editor in the runtime; seed it on mount and
  // discard it on leave so it never bleeds into another node's screen.
  React.useEffect(() => {
    if (node) app.beginRename("node", node.node_id, node.display_name ?? "");
    return () => app.cancelRename();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.node_id]);

  if (!node) {
    return (
      <Screen>
        <EmptyState icon="server" title="Node not found" description="It may have been removed." />
      </Screen>
    );
  }

  const online = node.status === "ACTIVE";
  const used = node.used_bytes ?? 0;
  const capacity = node.total_bytes ?? 0;

  return (
    <Screen>
      <AppStatusLine />

      <ThemedText variant="label" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
        Display name
      </ThemedText>
      <TextField value={app.renameValue} onChangeText={app.setRenameValue} placeholder="Node name" />
      <Button
        title={app.busy === `renaming-${node.node_id}` ? "Saving…" : "Save name"}
        variant="secondary"
        onPress={() => void app.submitRename()}
        disabled={app.busy !== null}
        style={{ marginTop: theme.spacing.sm }}
      />

      <Card style={{ paddingHorizontal: theme.spacing.md, marginTop: theme.spacing.xl }}>
        <Row label="Status">
          <StatusBadge status={online ? "synced" : "offline"} />
        </Row>
        <Divider />
        <Row label="Primary">
          <ThemedText variant="mono">{node.is_primary ? "yes" : "no"}</ThemedText>
        </Row>
        <Divider />
        <Row label="Last seen">
          <ThemedText variant="mono">{node.last_seen_at ? timeAgo(node.last_seen_at) : "never"}</ThemedText>
        </Row>
        {capacity > 0 ? (
          <>
            <Divider />
            <View style={{ paddingVertical: theme.spacing.md, gap: theme.spacing.sm }}>
              <Row label="Capacity">
                <ThemedText variant="mono">
                  {formatBytes(used)} / {formatBytes(capacity)}
                </ThemedText>
              </Row>
              <Progress value={used / capacity} />
            </View>
          </>
        ) : null}
      </Card>

      <ThemedText variant="label" tone="muted" style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}>
        Identity fingerprint
      </ThemedText>
      <View
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.secondary,
          borderRadius: theme.radius.sm,
          padding: theme.spacing.md,
        }}
      >
        <ThemedText variant="monoSmall" tone="muted">
          {node.public_key}
        </ThemedText>
      </View>

      <View style={{ marginTop: theme.spacing.xl, gap: theme.spacing.sm }}>
        <Button
          title={app.busy === `pinging-node-${node.node_id}` ? "Pinging…" : "Ping node"}
          variant="secondary"
          icon="wifi"
          onPress={() => void app.pingNode(node)}
          disabled={app.busy !== null || !online}
        />
        {isTrusted ? (
          <>
            {/* Explicit re-pair for the node-reset case: the node lost its
                devices table but this phone still has the trusted entry. */}
            <Button
              title={app.busy === `pairing-node-${node.node_id}` ? "Re-pairing…" : "Re-pair this node"}
              variant="secondary"
              icon="link"
              onPress={() => void app.pairNode(node.node_id)}
              disabled={app.busy !== null}
            />
            <Button
              title="Unpair on this device"
              variant="destructive"
              icon="link"
              onPress={() => setConfirmUnpair(true)}
              disabled={app.busy !== null}
            />
          </>
        ) : null}
        <ThemedText variant="caption" tone="muted">
          Setting a primary node and forgetting a node account-wide are not available yet.
        </ThemedText>
      </View>

      <ConfirmDialog
        visible={confirmUnpair}
        title="Unpair this node?"
        message="This device drops its local LAN trust for the node. The account still knows the node and you can re-pair it."
        confirmLabel="Unpair"
        destructive
        onConfirm={() => {
          setConfirmUnpair(false);
          void app.unpairTrustedNode(node.node_id);
        }}
        onCancel={() => setConfirmUnpair(false)}
      />
    </Screen>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
      }}
    >
      <ThemedText variant="caption" tone="muted">
        {label}
      </ThemedText>
      {children}
    </View>
  );
}
