import * as React from "react";
import { Button, Text, TextInput, View } from "react-native";

import { useApp } from "../runtime/context";
import { ScreenScroll } from "../runtime/ScreenScroll";
import { Section } from "../runtime/ui";
import { styles } from "../runtime/styles";

/**
 * Node pairing hub: bootstrap a brand-new node with a pairing code, pair this
 * device with an existing node, discover nodes on the LAN, and finish the
 * device↔node local trust handshake.
 */
export function HomeScreen() {
  const {
    device,
    authed,
    busy,
    createCode,
    code,
    codeStatus,
    loadNodes,
    nodes,
    selectedNode,
    setSelectedNode,
    pingNode,
    renaming,
    renameValue,
    setRenameValue,
    beginRename,
    cancelRename,
    submitRename,
    issueToken,
    pairingUrl,
    scan,
    candidates,
    probe,
    selectCandidate,
    host,
    setHost,
    probeManual,
    pending,
    pairOnDevice,
    authenticateOnDevice,
  } = useApp();

  return (
    <ScreenScroll title="Pair a Storage Node">
      <Text style={styles.hint}>
        Device id: {device?.device_id ?? "…"} (key stays on this device)
      </Text>

      <Section title="2 · Add a new Storage Node">
        <Button
          title="Create pairing code"
          onPress={() => void createCode()}
          disabled={!authed || busy !== null}
        />
        {code && (
          <>
            <Text style={styles.code}>{code.code}</Text>
            <Text style={styles.hint}>
              On the node run: nodus node pair --relay {"<relay-url>"} --code {code.code}
            </Text>
            <Text style={codeStatus === "paired" ? styles.ok : styles.hint}>
              {codeStatus === "paired" ? "Node paired." : "Waiting for the node to redeem the code…"}
            </Text>
          </>
        )}
      </Section>

      <Section title="3 · Pair this device with an existing node">
        <Button title="Load my nodes" onPress={() => void loadNodes()} disabled={!authed || busy !== null} />
        {nodes.map((n) => (
          <View key={n.node_id} style={styles.radioRow}>
            <Text
              style={[styles.nodeLabel, selectedNode === n.node_id && styles.nodeSelected]}
              onPress={() => setSelectedNode(n.node_id)}
            >
              {n.display_name ?? `${n.node_id.slice(0, 12)}…`}
              {n.is_primary ? " (primary)" : ""} — {n.status}
            </Text>
            <Button
              title={busy === `pinging-node-${n.node_id}` ? "Pinging…" : "Ping"}
              onPress={() => void pingNode(n)}
              disabled={busy !== null || n.status !== "ACTIVE"}
            />
            <Button
              title="Rename"
              onPress={() => beginRename("node", n.node_id, n.display_name ?? "")}
              disabled={busy !== null}
            />
          </View>
        ))}
        {renaming?.kind === "node" && (
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
        <View style={styles.spacer} />
        <Button
          title="Issue pairing token"
          onPress={() => void issueToken()}
          disabled={!authed || !selectedNode || busy !== null}
        />
        {pairingUrl && <Text style={styles.mono}>{pairingUrl}</Text>}
      </Section>

      <Section title="4 · Find the node on your LAN">
        <Button title="Scan local network" onPress={() => void scan()} disabled={busy !== null} />
        {candidates.map((c) => (
          <Text
            key={c.host}
            style={[styles.nodeLabel, probe?.host === c.host && styles.nodeSelected]}
            onPress={() => selectCandidate(c)}
          >
            {c.host} — {c.node_id.slice(0, 12)}… (v{c.schema_version})
          </Text>
        ))}
        <TextInput
          style={styles.input}
          value={host}
          onChangeText={setHost}
          placeholder="manual host, e.g. 192.168.1.10"
          autoCorrect={false}
        />
        <Button title="Probe host" onPress={() => void probeManual()} disabled={!host.trim() || busy !== null} />
        {probe && (
          <Text style={styles.hint}>
            {probe.host}: {probe.node_id.slice(0, 12)}… (v{probe.schema_version})
          </Text>
        )}
      </Section>

      <Section title="5 · Finish locally">
        <Button
          title="Pair this device"
          onPress={() => void pairOnDevice()}
          disabled={!pending || !probe || busy !== null}
        />
        <View style={styles.spacer} />
        <Button
          title="Authenticate (re-auth)"
          onPress={() => void authenticateOnDevice()}
          disabled={!probe || busy !== null}
        />
      </Section>
    </ScreenScroll>
  );
}
