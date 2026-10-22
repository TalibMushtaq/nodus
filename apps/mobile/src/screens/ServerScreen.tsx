// Server selection screen.
//
// Used in two places: the first-run gate (no `relayUrl` yet) and Settings →
// Server for changing it later. The URL is entered here instead of coming from
// a build-time `.env`, so one build can point at any self-hosted Relay.

import * as React from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  Button,
  Card,
  Icon,
  Screen,
  TextField,
  ThemedText,
  useTheme,
} from "../design";
import type { SettingsStackParamList } from "../navigation/types";
import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";

type SettingsNav = NativeStackNavigationProp<SettingsStackParamList, "Server">;

export function ServerScreen({
  onboarding = false,
  onSaved,
}: {
  /** First-run layout adds the Nodus brand header; Settings uses the stack header. */
  onboarding?: boolean;
  onSaved?: () => void;
}) {
  const { relayUrl, busy, connectServer } = useApp();
  const theme = useTheme();
  const [value, setValue] = React.useState(relayUrl ?? "");
  // Offered only after an attempt fails, so a temporarily unreachable server
  // can still be saved deliberately. Validation is always enforced.
  const [failed, setFailed] = React.useState(false);

  const submit = async (skipProbe: boolean) => {
    setFailed(false);
    const ok = await connectServer(value, { skipProbe });
    if (ok) onSaved?.();
    else setFailed(true);
  };

  const busyConnecting = busy === "connecting-server";

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      edges={onboarding ? ["top", "bottom"] : ["bottom"]}
    >
      <Screen>
        {onboarding ? (
          <View
            style={{
              alignItems: "center",
              marginTop: theme.spacing.xxl,
              marginBottom: theme.spacing.xl,
            }}
          >
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.primary,
                alignItems: "center",
                justifyContent: "center",
                marginBottom: theme.spacing.md,
              }}
            >
              <Icon name="database" size={24} color={theme.colors.primaryForeground} />
            </View>
            <ThemedText variant="title">Connect to your server</ThemedText>
            <ThemedText variant="caption" tone="muted" style={{ marginTop: 4, textAlign: "center" }}>
              Enter the Relay URL for your Nodus account. You only need to do this once.
            </ThemedText>
          </View>
        ) : null}

        <AppStatusLine />

        <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
          <TextField
            label="Server URL"
            value={value}
            onChangeText={setValue}
            placeholder="https://relay.example.com"
            hint="Remote servers must use https://. Plain http:// is allowed only for localhost and the Android emulator (10.0.2.2)."
            keyboardType="url"
            autoCapitalize="none"
          />

          <Button
            title={busyConnecting ? "Connecting…" : onboarding ? "Connect" : "Save server"}
            onPress={() => void submit(false)}
            disabled={busy !== null || !value.trim()}
            loading={busyConnecting}
          />

          {failed ? (
            <Button
              title="Save without testing"
              variant="ghost"
              onPress={() => void submit(true)}
              disabled={busy !== null || !value.trim()}
            />
          ) : null}
        </Card>

        {!onboarding ? (
          <ThemedText
            variant="caption"
            tone="muted"
            style={{ marginTop: theme.spacing.md, textAlign: "center" }}
          >
            {"Changing the server signs you out and clears this device's Relay session."}
          </ThemedText>
        ) : null}
      </Screen>
    </SafeAreaView>
  );
}

/** Settings-stack wrapper: pops back after a successful same-server save. */
export function SettingsServerScreen() {
  const navigation = useNavigation<SettingsNav>();
  return (
    <ServerScreen
      onSaved={() => {
        if (navigation.canGoBack()) navigation.goBack();
      }}
    />
  );
}
