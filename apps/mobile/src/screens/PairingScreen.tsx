// Pairing screen: bootstrap a brand-new node, pair this device with an existing
// node over the LAN, and finish the local trust handshake.
//
// Two distinct flows (plan §7) are kept visually separate:
//  1. Add a new Storage Node — mint a one-time NODUS-XXXX code for the operator.
//  2. Pair with an existing node — issue a device-bound token and pair locally.

import * as React from "react";
import { Pressable, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import {
  Button,
  Card,
  Icon,
  Screen,
  TextField,
  ThemedText,
  useTheme,
} from "../design";

export function PairingScreen() {
  const app = useApp();
  const theme = useTheme();

  return (
    <Screen>
      <AppStatusLine />

      <Block title="This device">
        <ThemedText variant="monoSmall" tone="muted">
          {app.device?.device_id ?? "…"}
        </ThemedText>
        <ThemedText variant="caption" tone="muted">
          The device key never leaves this device.
        </ThemedText>
      </Block>

      <Block title="Add a new storage node">
        <Button
          title={app.busy === "creating-code" ? "Creating…" : "Create pairing code"}
          onPress={() => void app.createCode()}
          disabled={!app.authed || app.busy !== null}
        />
        {app.code ? (
          <Card style={{ padding: theme.spacing.lg, alignItems: "center", gap: theme.spacing.sm }}>
            <ThemedText variant="mono" style={{ fontSize: 22, letterSpacing: 2 }}>
              {app.code.code}
            </ThemedText>
            <ThemedText variant="caption" tone="muted" style={{ textAlign: "center" }}>
              On the node run:{" "}
              <ThemedText variant="monoSmall">
                nodus node pair --relay &lt;url&gt; --code {app.code.code}
              </ThemedText>
            </ThemedText>
            <ThemedText
              variant="caption"
              tone={app.codeStatus === "paired" ? "accent" : "muted"}
            >
              {app.codeStatus === "paired"
                ? "Node paired."
                : "Waiting for the node to redeem the code…"}
            </ThemedText>
          </Card>
        ) : null}
      </Block>

      <Block title="Pair with an existing node">
        <Button
          title="Load my nodes"
          variant="secondary"
          onPress={() => void app.loadNodes()}
          disabled={!app.authed || app.busy !== null}
        />
        {app.nodes.map((n) => (
          <Pressable
            key={n.node_id}
            onPress={() => app.setSelectedNode(n.node_id)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.spacing.md,
              paddingVertical: theme.spacing.sm,
              paddingHorizontal: theme.spacing.md,
              borderWidth: 1,
              borderColor: app.selectedNode === n.node_id ? theme.colors.accent : theme.colors.border,
              borderRadius: theme.radius.sm,
              backgroundColor:
                app.selectedNode === n.node_id ? `${theme.colors.accent}10` : theme.colors.card,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <ThemedText variant="bodyMedium" numberOfLines={1}>
                {n.display_name ?? `${n.node_id.slice(0, 12)}…`}
                {n.is_primary ? " (primary)" : ""}
              </ThemedText>
              <ThemedText variant="monoSmall" tone="muted">
                {n.status}
              </ThemedText>
            </View>
            {app.selectedNode === n.node_id ? (
              <Icon name="check" size={16} color={theme.colors.accent} />
            ) : null}
          </Pressable>
        ))}
        <Button
          title={app.busy === "issuing-token" ? "Issuing…" : "Issue pairing token"}
          onPress={() => void app.issueToken()}
          disabled={!app.authed || !app.selectedNode || app.busy !== null}
        />
        {app.pairingUrl ? (
          <Card style={{ padding: theme.spacing.lg, alignItems: "center", gap: theme.spacing.md }}>
            <QRCode value={app.pairingUrl} size={160} backgroundColor={theme.colors.card} color={theme.colors.foreground} />
            <ThemedText variant="monoSmall" tone="muted" style={{ textAlign: "center" }}>
              {app.pairingUrl}
            </ThemedText>
            <Button
              title="Copy pairing link"
              variant="secondary"
              icon="copy"
              onPress={() => void Clipboard.setStringAsync(app.pairingUrl ?? "")}
            />
          </Card>
        ) : null}
      </Block>

      <Block title="Find the node on your LAN">
        <Button
          title={app.busy === "scanning" ? "Scanning…" : "Scan local network"}
          variant="secondary"
          onPress={() => void app.scan()}
          disabled={app.busy !== null}
        />
        {app.candidates.map((c) => (
          <Pressable
            key={c.host}
            onPress={() => app.selectCandidate(c)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.spacing.md,
              paddingVertical: theme.spacing.sm,
              paddingHorizontal: theme.spacing.md,
              borderWidth: 1,
              borderColor: app.probe?.host === c.host ? theme.colors.accent : theme.colors.border,
              borderRadius: theme.radius.sm,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <ThemedText variant="monoSmall">{c.host}</ThemedText>
              <ThemedText variant="monoSmall" tone="muted">
                {c.node_id.slice(0, 12)}… (v{c.schema_version})
              </ThemedText>
            </View>
          </Pressable>
        ))}
        <TextField
          label="Manual host"
          value={app.host}
          onChangeText={app.setHost}
          placeholder="192.168.1.10"
          autoCapitalize="none"
        />
        <Button
          title="Probe host"
          variant="secondary"
          onPress={() => void app.probeManual()}
          disabled={!app.host.trim() || app.busy !== null}
        />
        {app.probe ? (
          <ThemedText variant="monoSmall" tone="muted">
            {app.probe.host}: {app.probe.node_id.slice(0, 12)}… (v{app.probe.schema_version})
          </ThemedText>
        ) : null}
      </Block>

      <Block title="Finish locally">
        <Button
          title="Pair this device"
          onPress={() => void app.pairOnDevice()}
          disabled={!app.pending || !app.probe || app.busy !== null}
        />
        <Button
          title="Authenticate (re-auth)"
          variant="secondary"
          onPress={() => void app.authenticateOnDevice()}
          disabled={!app.probe || app.busy !== null}
        />
      </Block>

      <Block title="Trusted nodes (this device)" last>
        {app.trusted.length === 0 ? (
          <ThemedText variant="caption" tone="muted">
            Nothing paired yet.
          </ThemedText>
        ) : (
          app.trusted.map((t) => (
            <ThemedText key={t.node_id} variant="monoSmall" tone="muted">
              {t.node_id.slice(0, 12)}… @ {t.host}
            </ThemedText>
          ))
        )}
      </Block>
    </Screen>
  );
}

function Block({
  title,
  children,
  last = false,
}: {
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ marginBottom: last ? 0 : theme.spacing.xl }}>
      <ThemedText variant="sectionLabel" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
        {title}
      </ThemedText>
      <View style={{ gap: theme.spacing.sm }}>{children}</View>
    </View>
  );
}
