import "./src/compat";

// Storage Node pairing & LAN discovery — mobile client.
//
// Mirrors the web pairing screen (apps/web/app/pair/page.tsx) so the two
// clients behave identically: Relay Path B issues the token, the LAN listener
// on the node redeems it. Unlike the web app (which skips active mDNS), mobile
// offers a LAN sweep in addition to manual host entry — see
// src/discovery.ts for the Exo-Go-compatible trade-off vs native mDNS.
//
// The device's Ed25519 keypair lives only in the OS keychain (expo-secure-store),
// never leaves the device, and is what binds + signs pairing tokens.

import * as React from "react";
import {
  Button,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  NodeClient,
  NodeClientError,
  nodusBaseUrl,
} from "@repo/relay-client/local-discovery";
import {
  identityPrivateKey,
  identityPublicKey,
  type StoredDeviceIdentity,
} from "@repo/relay-client/device-identity";

import { myLanV4, probeHost, scanLan, type LanCandidate } from "./src/discovery";
import {
  relayCreatePairingSession,
  relayLogin,
  relayNodes,
  relayRegisterDevice,
  type PairingSession,
  type RelayNode,
} from "./src/relay";
import {
  addTrustedNode,
  getTrustedNodes,
  loadOrCreateDevice,
  type TrustedNode,
} from "./src/storage";

export default function App() {
  // ── device identity (created on first launch, key output of this app) ────
  const [device, setDevice] = React.useState<StoredDeviceIdentity | null>(null);

  // ── relay auth + catalog ──────────────────────────────────────────────────
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [jwt, setJwt] = React.useState<string | null>(null);
  const [nodes, setNodes] = React.useState<RelayNode[]>([]);
  const [selectedNode, setSelectedNode] = React.useState<string | null>(null);

  // ── token issuance (RELAY_PATH_B) ─────────────────────────────────────────
  const [pending, setPending] = React.useState<PairingSession | null>(null);

  // ── LAN discovery + local pairing ─────────────────────────────────────────
  const [candidates, setCandidates] = React.useState<LanCandidate[]>([]);
  const [host, setHost] = React.useState("");
  const [probe, setProbe] = React.useState<LanCandidate | null>(null);
  const [trusted, setTrusted] = React.useState<TrustedNode[]>([]);

  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      setDevice(await loadOrCreateDevice());
      setTrusted(await getTrustedNodes());
    })();
  }, []);

  const signIn = React.useCallback(async () => {
    setBusy("signing-in");
    setError(null);
    try {
      setJwt(await relayLogin(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [email, password]);

  const loadNodes = React.useCallback(async () => {
    if (!jwt) return;
    setBusy("loading-nodes");
    setError(null);
    try {
      setNodes(await relayNodes(jwt));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [jwt]);

  const issueToken = React.useCallback(async () => {
    if (!device || !jwt || !selectedNode) return;
    setBusy("issuing-token");
    setError(null);
    setNotice(null);
    try {
      await relayRegisterDevice(jwt, device);
      setPending(await relayCreatePairingSession(jwt, selectedNode, device.device_id));
      setNotice("Token issued — finish locally to pair this device.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, jwt, selectedNode]);

  const scan = React.useCallback(async () => {
    setBusy("scanning");
    setError(null);
    setNotice(null);
    try {
      const myIp = await myLanV4();
      if (!myIp) {
        setError("Could not determine this device's LAN IP — enter the node host manually.");
        return;
      }
      setCandidates(await scanLan(myIp));
      setNotice("LAN sweep done. Pick a node below or enter a host manually.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const probeManual = React.useCallback(async () => {
    setBusy("probing");
    setError(null);
    setNotice(null);
    try {
      setProbe(await probeHost(host));
    } catch (err) {
      setProbe(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [host]);

  const selectCandidate = React.useCallback((c: LanCandidate) => {
    setHost(c.host);
    setProbe(c);
    setError(null);
  }, []);

  const pairOnDevice = React.useCallback(async () => {
    if (!device || !pending || !probe) return;
    setBusy("pairing");
    setError(null);
    setNotice(null);
    try {
      const client = new NodeClient(nodusBaseUrl(probe.host));
      const confirm = (await client.pair(
        pending.token,
        pending.node_id ?? selectedNode ?? "",
        device.device_id,
        identityPublicKey(device),
      )) as { node_id?: string; account_id?: string };
      await addTrustedNode({
        node_id: confirm.node_id ?? pending.node_id ?? "",
        host: probe.host,
        account_id: confirm.account_id ?? "local_push",
        device_id: device.device_id,
        paired_at: new Date().toISOString(),
      });
      setTrusted(await getTrustedNodes());
      setNotice("Paired — this device is now trusted by the node.");
    } catch (err) {
      setError(err instanceof NodeClientError ? `pair failed: ${err.message}` : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, pending, probe, selectedNode]);

  const authenticateOnDevice = React.useCallback(async () => {
    if (!device || !probe) return;
    setBusy("authing");
    setError(null);
    setNotice(null);
    try {
      const client = new NodeClient(nodusBaseUrl(probe.host));
      await client.authenticate(device.device_id, identityPrivateKey(device));
      setNotice("Authenticated — the node accepted this device's signature.");
    } catch (err) {
      setError(err instanceof NodeClientError ? `auth failed: ${err.message}` : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, probe]);

  const pairingUrl =
    pending && device
      ? `nodus://pair?node_id=${encodeURIComponent(pending.node_id ?? selectedNode ?? "")}&pubkey=${encodeURIComponent(device.public_key)}&token=${encodeURIComponent(pending.token)}`
      : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Pair a Storage Node</Text>
      <Text style={styles.hint}>
        Device id: {device?.device_id ?? "…"} (key stays on this device)
      </Text>

      <Section title="1 · Relay sign-in">
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="email"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="password"
          secureTextEntry
        />
        <Button title={jwt ? "Signed in" : "Sign in"} onPress={() => void signIn()} disabled={!device || busy !== null || !!jwt} />
      </Section>

      <Section title="2 · Choose your node">
        <Button title="Load my nodes" onPress={() => void loadNodes()} disabled={!jwt || busy !== null} />
        {nodes.map((n) => (
          <View key={n.node_id} style={styles.radioRow}>
            <Text
              style={[styles.nodeLabel, selectedNode === n.node_id && styles.nodeSelected]}
              onPress={() => setSelectedNode(n.node_id)}
            >
              {n.node_id.slice(0, 12)}…{n.is_primary ? " (primary)" : ""} — {n.status}
            </Text>
          </View>
        ))}
        <View style={styles.spacer} />
        <Button
          title="Issue pairing token"
          onPress={() => void issueToken()}
          disabled={!jwt || !selectedNode || busy !== null}
        />
        {pairingUrl && <Text style={styles.mono}>{pairingUrl}</Text>}
      </Section>

      <Section title="3 · Find the node on your LAN">
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

      <Section title="4 · Finish locally">
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

      <Section title="Trusted nodes (this device)">
        {trusted.length === 0 && <Text style={styles.hint}>Nothing paired yet.</Text>}
        {trusted.map((t) => (
          <Text key={t.node_id} style={styles.hint}>
            {t.node_id.slice(0, 12)}… @ {t.host} — paired {t.paired_at}
          </Text>
        ))}
      </Section>

      {busy && <Text style={styles.hint}>Working… ({busy})</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      {notice && !error && <Text style={styles.ok}>{notice}</Text>}
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: "700", marginBottom: 4 },
  hint: { color: "#666", marginVertical: 2 },
  section: { borderTopWidth: 1, borderTopColor: "#eee", paddingVertical: 12 },
  sectionTitle: { fontSize: 16, fontWeight: "600", marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
  },
  radioRow: { marginVertical: 2 },
  nodeLabel: { color: "#111", paddingVertical: 4 },
  nodeSelected: { color: "#1a73e8", fontWeight: "600" },
  mono: {
    marginTop: 8,
    color: "#333",
    fontSize: 12,
    backgroundColor: "#f5f5f5",
    padding: 8,
    borderRadius: 4,
  },
  spacer: { height: 8 },
  error: { color: "#c0392b", marginTop: 8 },
  ok: { color: "#27ae60", marginTop: 8 },
});