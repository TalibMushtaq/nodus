import * as React from "react";
import { Button, Text, TextInput, View } from "react-native";

import { useApp } from "../runtime/context";
import { ScreenScroll } from "../runtime/ScreenScroll";
import { Section } from "../runtime/ui";
import { styles } from "../runtime/styles";

/** Devices registered to the account plus the nodes this device trusts locally. */
export function DevicesScreen() {
  const {
    authed,
    busy,
    device,
    devices,
    loadDevices,
    pingDevice,
    revokeDevice,
    renaming,
    renameValue,
    setRenameValue,
    beginRename,
    cancelRename,
    submitRename,
    trusted,
  } = useApp();

  return (
    <ScreenScroll title="Devices">
      <Section title="8 · Devices">
        <Button title="Load devices" onPress={() => void loadDevices()} disabled={!authed || busy !== null} />
        {devices.map((d) => (
          <View key={d.device_id} style={styles.radioRow}>
            <Text style={styles.hint}>
              {d.display_name ?? `${d.device_id.slice(0, 12)}…`}
              {d.device_id === device?.device_id ? " (this device)" : ""} · {d.status}
            </Text>
            <View style={styles.buttonRow}>
              <Button
                title={busy === `pinging-${d.device_id}` ? "Pinging…" : "Ping"}
                onPress={() => void pingDevice(d)}
                disabled={busy !== null || d.status !== "ACTIVE"}
              />
              <Button
                title={busy === `revoking-${d.device_id}` ? "Revoking…" : "Revoke"}
                onPress={() => revokeDevice(d)}
                disabled={busy !== null || d.status !== "ACTIVE"}
              />
              <Button
                title="Rename"
                onPress={() => beginRename("device", d.device_id, d.display_name ?? "")}
                disabled={busy !== null}
              />
            </View>
          </View>
        ))}
        {renaming?.kind === "device" && (
          <View style={styles.buttonRow}>
            <TextInput
              style={styles.input}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="Display name (blank to clear)"
              autoFocus
            />
            <Button
              title={busy === `renaming-${renaming.id}` ? "Saving…" : "Save"}
              onPress={() => void submitRename()}
              disabled={busy !== null}
            />
            <Button title="Cancel" onPress={cancelRename} />
          </View>
        )}
      </Section>

      <Section title="Trusted nodes (this device)">
        {trusted.length === 0 && <Text style={styles.hint}>Nothing paired yet.</Text>}
        {trusted.map((t) => (
          <Text key={t.node_id} style={styles.hint}>
            {t.node_id.slice(0, 12)}… @ {t.host} — paired {t.paired_at}
          </Text>
        ))}
      </Section>
    </ScreenScroll>
  );
}
