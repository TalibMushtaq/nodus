// Settings tab: account, appearance, storage preferences, and links to the
// Security and Trash screens. Only backed controls are shown — the web app
// removed its cosmetic toggles and this mirrors that.

import * as React from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import {
  Card,
  Chip,
  Divider,
  Screen,
  ScreenHeader,
  SettingRow,
  ThemedText,
  Toggle,
  useTheme,
  useThemeMode,
} from "../design";
import type { SettingsStackParamList } from "../navigation/types";

type Nav = NativeStackNavigationProp<SettingsStackParamList, "Settings">;

const SHARD_SIZES = [4, 8, 16];
const THEME_MODES = ["light", "dark", "system"] as const;

export function SettingsScreen() {
  const app = useApp();
  const theme = useTheme();
  const { mode, setMode } = useThemeMode();
  const navigation = useNavigation<Nav>();

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Settings" />
      <Screen>
        <AppStatusLine />

        <Section title="Account">
          <Card>
            <SettingRow label="Email" detail={app.email || "not signed in"} />
            <Divider />
            <SettingRow
              label="Sign out"
              right={<ThemedText variant="caption" tone="muted">›</ThemedText>}
              onPress={() => void app.signOut()}
            />
          </Card>
        </Section>

        <Section title="Appearance">
          <Card>
            <View
              style={{
                flexDirection: "row",
                gap: theme.spacing.sm,
                padding: theme.spacing.md,
              }}
            >
              {THEME_MODES.map((m) => (
                <Chip
                  key={m}
                  label={m[0].toUpperCase() + m.slice(1)}
                  active={mode === m}
                  onPress={() => setMode(m)}
                />
              ))}
            </View>
          </Card>
        </Section>

        <Section title="Storage node">
          <Card>
            <View style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
              <ThemedText variant="caption" tone="muted">
                Shard size for new uploads
              </ThemedText>
              <View style={{ flexDirection: "row", gap: theme.spacing.sm }}>
                {SHARD_SIZES.map((mb) => (
                  <Chip
                    key={mb}
                    label={`${mb} MB`}
                    active={app.shardSizeBytes === mb * 1024 * 1024}
                    onPress={() => app.chooseShardSize(mb * 1024 * 1024)}
                  />
                ))}
              </View>
            </View>
          </Card>
        </Section>

        <Section title="Security">
          <Card>
            <SettingRow
              label="Recovery key"
              right={<ThemedText variant="caption" tone="muted">›</ThemedText>}
              onPress={() => navigation.navigate("Security")}
            />
            <Divider />
            <SettingRow
              label="Device revocation"
              detail="Revoke access from the Devices tab"
            />
          </Card>
        </Section>

        <Section title="Storage & cleanup">
          <Card>
            <SettingRow
              label="Deleted files"
              detail="Restore or permanently delete soft-deleted items"
              right={<ThemedText variant="caption" tone="muted">›</ThemedText>}
              onPress={() => navigation.navigate("Trash")}
            />
            <Divider />
            <SettingRow label="Tombstone retention" detail="90 days (policy)" />
          </Card>
        </Section>

        <Section title="Notifications">
          <Card>
            <SettingRow
              label="Conflict alerts"
              right={
                <Toggle
                  value={app.notificationPrefs.conflicts}
                  onChange={(v) => app.setNotificationPref("conflicts", v)}
                />
              }
            />
            <Divider />
            <SettingRow
              label="Device offline alerts"
              right={
                <Toggle
                  value={app.notificationPrefs.deviceOffline}
                  onChange={(v) => app.setNotificationPref("deviceOffline", v)}
                />
              }
            />
            <Divider />
            <SettingRow
              label="Sync complete alerts"
              right={
                <Toggle
                  value={app.notificationPrefs.syncComplete}
                  onChange={(v) => app.setNotificationPref("syncComplete", v)}
                />
              }
            />
          </Card>
          <ThemedText variant="caption" tone="muted" style={{ marginTop: theme.spacing.sm }}>
            Saved on this device. Delivery uses the relay push service once it is available.
          </ThemedText>
        </Section>

        <Section title="About">
          <Card>
            <SettingRow label="App version" detail="1.0.0" />
            <Divider />
            <SettingRow label="Protocol version" detail="nodus-proto/3" />
          </Card>
        </Section>

        <View style={{ height: theme.spacing.xl }} />
      </Screen>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ marginBottom: theme.spacing.xl }}>
      <ThemedText variant="sectionLabel" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
        {title}
      </ThemedText>
      {children}
    </View>
  );
}
