// Security screen: recovery key card, key-envelope coverage, envelope backup
// export, and the device revocation list.

import * as React from "react";
import { View } from "react-native";
import { timeAgo } from "@repo/sdk";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import {
  Button,
  Card,
  Divider,
  EmptyState,
  Screen,
  SettingRow,
  TextField,
  ThemedText,
  useTheme,
} from "../design";

export function SecurityScreen() {
  const app = useApp();
  const theme = useTheme();
  const [refreshing, setRefreshing] = React.useState(false);
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [passwordMismatch, setPasswordMismatch] = React.useState(false);

  React.useEffect(() => {
    if (app.authed) {
      void app.loadEnvelopes();
      void app.loadDevices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.authed]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([app.loadEnvelopes(), app.loadDevices()]);
    } finally {
      setRefreshing(false);
    }
  };

  const submitPassword = async () => {
    if (newPassword !== confirmPassword) {
      setPasswordMismatch(true);
      return;
    }
    setPasswordMismatch(false);
    const ok = await app.changePassword(currentPassword, newPassword);
    if (ok) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    }
  };

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <AppStatusLine />

      <ThemedText variant="sectionLabel" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
        Recovery key
      </ThemedText>
      <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <ThemedText variant="caption" tone="muted">
          Anyone with these 24 words can recover the account. Keep them offline.
        </ThemedText>
        {app.revealedPhrase ? (
          <View
            style={{
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.secondary,
              borderRadius: theme.radius.sm,
              padding: theme.spacing.md,
            }}
          >
            <ThemedText variant="monoSmall">{app.revealedPhrase}</ThemedText>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", gap: theme.spacing.sm }}>
          <Button
            title={app.revealedPhrase ? "Hide" : "Reveal"}
            variant="secondary"
            onPress={() => (app.revealedPhrase ? app.setRevealedPhrase(null) : void app.revealPhrase())}
            disabled={!app.authed || app.busy !== null}
            style={{ flex: 1 }}
          />
          {app.revealedPhrase ? (
            <Button
              title="Copy"
              variant="secondary"
              icon="copy"
              onPress={() => void app.copyPhrase()}
              disabled={app.busy !== null}
              style={{ flex: 1 }}
            />
          ) : null}
        </View>
        <Button
          title={app.busy === "rotating-recovery" ? "Regenerating…" : "Regenerate recovery key"}
          variant="destructive"
          onPress={() => app.rotateRecovery()}
          disabled={!app.authed || app.busy !== null}
        />
        {app.securityStatus ? (
          <ThemedText variant="caption" tone="muted">
            {app.securityStatus}
          </ThemedText>
        ) : null}
      </Card>

      <ThemedText
        variant="sectionLabel"
        tone="muted"
        style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}
      >
        Password & sessions
      </ThemedText>
      <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <TextField
          label="Current password"
          value={currentPassword}
          onChangeText={setCurrentPassword}
          secureTextEntry
        />
        <TextField label="New password" value={newPassword} onChangeText={setNewPassword} secureTextEntry />
        <TextField
          label="Confirm new password"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry
        />
        {passwordMismatch ? (
          <ThemedText variant="caption" tone="destructive">
            The new passwords do not match.
          </ThemedText>
        ) : null}
        <Button
          title={app.busy === "changing-password" ? "Changing…" : "Change password"}
          onPress={() => void submitPassword()}
          disabled={
            app.busy !== null || !currentPassword || !newPassword || !confirmPassword
          }
        />
        <Button
          title={app.busy === "signing-out-others" ? "Signing out…" : "Sign out all other devices"}
          variant="destructive"
          onPress={() => void app.logoutAll()}
          disabled={app.busy !== null}
        />
      </Card>

      <ThemedText
        variant="sectionLabel"
        tone="muted"
        style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}
      >
        Key envelope coverage
      </ThemedText>
      <Card>
        {app.envelopeSummary.length === 0 ? (
          <View style={{ padding: theme.spacing.md }}>
            <ThemedText variant="caption" tone="muted">
              No envelope coverage loaded.
            </ThemedText>
          </View>
        ) : (
          app.envelopeSummary.map((s, index) => (
            <React.Fragment key={`${s.recipient_kind}:${s.recipient_id}`}>
              {index > 0 ? <Divider /> : null}
              <SettingRow
                label={`${s.recipient_kind} · ${s.recipient_id.slice(0, 12)}…`}
                detail={`${s.file_count} file · ${s.folder_count} folder${
                  s.last_updated ? ` · ${timeAgo(s.last_updated)}` : ""
                }`}
              />
            </React.Fragment>
          ))
        )}
      </Card>
      <View style={{ marginTop: theme.spacing.sm }}>
        <Button
          title={app.busy === "exporting-envelopes" ? "Exporting…" : "Export envelope backup"}
          variant="secondary"
          icon="download"
          onPress={() => void app.exportEnvelopes()}
          disabled={!app.authed || app.busy !== null}
        />
      </View>

      <ThemedText
        variant="sectionLabel"
        tone="muted"
        style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}
      >
        Device revocation
      </ThemedText>
      {app.devices.length === 0 ? (
        <EmptyState icon="phone" title="No devices" description="Registered devices will appear here." />
      ) : (
        <Card>
          {app.devices.map((d, index) => (
            <React.Fragment key={d.device_id}>
              {index > 0 ? <Divider /> : null}
              <SettingRow
                label={d.display_name ?? `${d.device_id.slice(0, 12)}…`}
                detail={`${d.status}${d.last_seen_at ? ` · ${timeAgo(d.last_seen_at)}` : ""}`}
                right={
                  <Button
                    title="Revoke"
                    variant="destructive"
                    onPress={() => app.revokeDevice(d)}
                    disabled={app.busy !== null || d.status !== "ACTIVE"}
                    style={{ paddingVertical: theme.spacing.sm, paddingHorizontal: theme.spacing.md }}
                  />
                }
              />
            </React.Fragment>
          ))}
        </Card>
      )}
    </Screen>
  );
}
