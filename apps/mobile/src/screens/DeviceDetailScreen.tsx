// Client-device detail: rename and revoke. Revocation is confirmed by the
// runtime action itself (it warns for self-revoke before dropping the session).

import * as React from "react";
import { View } from "react-native";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { timeAgo } from "@repo/sdk";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import {
  Button,
  Card,
  Divider,
  EmptyState,
  Screen,
  StatusBadge,
  TextField,
  ThemedText,
  useTheme,
} from "../design";
import type { DevicesStackParamList } from "../navigation/types";

export function DeviceDetailScreen() {
  const app = useApp();
  const theme = useTheme();
  const route = useRoute<RouteProp<DevicesStackParamList, "DeviceDetail">>();
  const device = app.devices.find((d) => d.device_id === route.params.deviceId);

  React.useEffect(() => {
    if (device) app.beginRename("device", device.device_id, device.display_name ?? "");
    return () => app.cancelRename();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device?.device_id]);

  if (!device) {
    return (
      <Screen>
        <EmptyState icon="phone" title="Device not found" description="It may have been removed." />
      </Screen>
    );
  }

  const active = device.status === "ACTIVE";
  const isSelf = device.device_id === app.device?.device_id;

  return (
    <Screen>
      <AppStatusLine />

      <ThemedText variant="label" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
        Display name
      </ThemedText>
      <TextField value={app.renameValue} onChangeText={app.setRenameValue} placeholder="Device name" />
      <Button
        title={app.busy === `renaming-${device.device_id}` ? "Saving…" : "Save name"}
        variant="secondary"
        onPress={() => void app.submitRename()}
        disabled={app.busy !== null}
        style={{ marginTop: theme.spacing.sm }}
      />

      <Card style={{ paddingHorizontal: theme.spacing.md, marginTop: theme.spacing.xl }}>
        <Row label="Status">
          <StatusBadge status={active ? "synced" : "offline"} />
        </Row>
        <Divider />
        <Row label="Last active">
          <ThemedText variant="mono">
            {device.last_seen_at ? timeAgo(device.last_seen_at) : "never"}
          </ThemedText>
        </Row>
      </Card>

      <ThemedText variant="label" tone="muted" style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}>
        Device ID
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
          {device.device_id}
        </ThemedText>
      </View>

      <View style={{ marginTop: theme.spacing.xl, gap: theme.spacing.sm }}>
        <Button
          title={
            app.busy === `revoking-${device.device_id}`
              ? "Revoking…"
              : isSelf
                ? "Revoke this device (signs you out)"
                : "Revoke access"
          }
          variant="destructive"
          icon="trash"
          onPress={() => app.revokeDevice(device)}
          disabled={app.busy !== null || !active}
        />
      </View>
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
