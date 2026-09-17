// Devices tab: storage nodes and client devices, restyled to the design.
//
// Both sections load on mount; rows push to their detail screens. Node/device
// rename lives in the detail screens (Phase 1 exposes it there rather than as
// inline editors on the list).

import * as React from "react";
import { Pressable, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { formatBytes, timeAgo } from "@repo/sdk";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import {
  Button,
  Card,
  Divider,
  EmptyState,
  Icon,
  IconButton,
  Progress,
  Screen,
  ScreenHeader,
  StatusBadge,
  ThemedText,
  useTheme,
} from "../design";
import type { DevicesStackParamList } from "../navigation/types";

type Nav = NativeStackNavigationProp<DevicesStackParamList, "Devices">;

export function DevicesScreen() {
  const app = useApp();
  const theme = useTheme();
  const navigation = useNavigation<Nav>();
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    if (app.authed) {
      void app.loadNodes();
      void app.loadDevices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.authed]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([app.loadNodes(), app.loadDevices()]);
    } finally {
      setRefreshing(false);
    }
  };

  const activeNodes = app.nodes.filter((n) => n.status === "ACTIVE").length;
  const activeDevices = app.devices.filter((d) => d.status === "ACTIVE").length;
  const total = app.nodes.length + app.devices.length;
  const offline = total - activeNodes - activeDevices;

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader
        title="Devices"
        subtitle={`${total} paired · ${offline} offline`}
        right={
          <IconButton
            name="plus"
            accessibilityLabel="Pair a device"
            onPress={() => navigation.navigate("Pairing")}
          />
        }
      />
      <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
        <AppStatusLine />

        {total === 0 ? (
          <EmptyState
            icon="server"
            title="No devices paired"
            description="Pair a storage node to start backing up your files."
            action={<Button title="Pair a device" icon="plus" onPress={() => navigation.navigate("Pairing")} />}
          />
        ) : null}

        {app.nodes.length > 0 ? (
          <View style={{ marginBottom: theme.spacing.xl }}>
            <ThemedText variant="sectionLabel" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
              Storage nodes
            </ThemedText>
            <Card>
              {app.nodes.map((n, index) => {
                const online = n.status === "ACTIVE";
                const used = n.used_bytes ?? 0;
                const capacity = n.total_bytes ?? 0;
                return (
                  <React.Fragment key={n.node_id}>
                    {index > 0 ? <Divider /> : null}
                    <Pressable
                      onPress={() => navigation.navigate("NodeDetail", { nodeId: n.node_id })}
                      style={({ pressed }) => [
                        {
                          flexDirection: "row",
                          alignItems: "center",
                          gap: theme.spacing.md,
                          paddingHorizontal: theme.spacing.md,
                          paddingVertical: theme.spacing.md,
                          opacity: pressed ? 0.7 : 1,
                        },
                      ]}
                    >
                      <View
                        style={{
                          width: 36,
                          height: 36,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                          backgroundColor: theme.colors.secondary,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon name="server" size={17} color={theme.colors.mutedForeground} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
                          <ThemedText variant="bodyMedium" numberOfLines={1}>
                            {n.display_name ?? `${n.node_id.slice(0, 12)}…`}
                          </ThemedText>
                          {n.is_primary ? (
                            <ThemedText variant="monoSmall" tone="accent">
                              PRIMARY
                            </ThemedText>
                          ) : null}
                          <StatusBadge status={online ? "synced" : "offline"} variant="dot" />
                        </View>
                        {capacity > 0 ? (
                          <>
                            <Progress value={used / capacity} />
                            <ThemedText variant="monoSmall" tone="muted">
                              {formatBytes(used)} / {formatBytes(capacity)}
                            </ThemedText>
                          </>
                        ) : (
                          <ThemedText variant="monoSmall" tone="muted">
                            {n.last_seen_at ? `Seen ${timeAgo(n.last_seen_at)}` : "Never seen"}
                          </ThemedText>
                        )}
                      </View>
                      <Icon name="chevronRight" size={16} color={theme.colors.mutedForeground} />
                    </Pressable>
                  </React.Fragment>
                );
              })}
            </Card>
          </View>
        ) : null}

        {app.devices.length > 0 ? (
          <View>
            <ThemedText variant="sectionLabel" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
              Client devices
            </ThemedText>
            <Card>
              {app.devices.map((d, index) => {
                const active = d.status === "ACTIVE";
                return (
                  <React.Fragment key={d.device_id}>
                    {index > 0 ? <Divider /> : null}
                    <Pressable
                      onPress={() => navigation.navigate("DeviceDetail", { deviceId: d.device_id })}
                      style={({ pressed }) => [
                        {
                          flexDirection: "row",
                          alignItems: "center",
                          gap: theme.spacing.md,
                          paddingHorizontal: theme.spacing.md,
                          paddingVertical: theme.spacing.md,
                          opacity: pressed ? 0.7 : 1,
                        },
                      ]}
                    >
                      <View
                        style={{
                          width: 36,
                          height: 36,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                          backgroundColor: theme.colors.secondary,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon name="phone" size={17} color={theme.colors.mutedForeground} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
                          <ThemedText variant="bodyMedium" numberOfLines={1}>
                            {d.display_name ?? `${d.device_id.slice(0, 12)}…`}
                            {d.device_id === app.device?.device_id ? " (this device)" : ""}
                          </ThemedText>
                          <StatusBadge status={active ? "synced" : "offline"} variant="dot" />
                        </View>
                        <ThemedText variant="monoSmall" tone="muted">
                          {d.last_seen_at ? `Active ${timeAgo(d.last_seen_at)}` : "Not seen yet"}
                        </ThemedText>
                      </View>
                      <Icon name="chevronRight" size={16} color={theme.colors.mutedForeground} />
                    </Pressable>
                  </React.Fragment>
                );
              })}
            </Card>
          </View>
        ) : null}
      </Screen>
    </View>
  );
}
