import "./src/compat";

// Nodus mobile client.
//
// Two distinct pairing flows are exposed here and must not be conflated
// (plan §7):
//  1. Account → new Storage Node bootstrap (§7b): the app mints a one-time
//     NODUS-XXXX-XXXX code, shows it with the operator's relay URL, and polls
//     `GET /nodes` until the node runs `nodus node pair` and appears.
//  2. Device ↔ node local trust (Phase 11): an already-registered node is
//     paired/authenticated over the LAN using a Relay-issued, device-bound
//     token.
//
// Authentication is the shared opaque session: the @repo/sdk native adapter
// captures the session ID the Relay returns to mobile and keeps it in the OS
// keychain as a bearer credential. No JWT is involved.

import * as React from "react";
import * as DocumentPicker from "expo-document-picker";
import {
  Button,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { ConnectionState } from "@repo/relay-client";
import { uploadFile, type SessionInfo } from "@repo/sdk";
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

import { discoverNodes, probeHost, type LanCandidate } from "./src/discovery";
import {
  getSessionToken,
  relayCreatePairingCode,
  relayCreatePairingSession,
  relayFiles,
  relayLogin,
  relayLogout,
  relayNodes,
  relayRegisterDevice,
  relayResolveConflict,
  relaySession,
  type PairingCode,
  type PairingSession,
  type RelayFile,
  type RelayNode,
} from "./src/relay";
import { MobileWs } from "./src/ws";
import { createMobileUploadDeps } from "./src/upload/deps";
import { fileUriSource } from "./src/upload/source";
import { loadOrCreateDevice } from "./src/storage";
import {
  addTrustedNode,
  getTrustedNodes,
  type TrustedNode,
} from "./src/store/trusted-nodes";

export default function App() {
  // ── device identity (created on first launch, key output of this app) ────
  const [device, setDevice] = React.useState<StoredDeviceIdentity | null>(null);

  // ── relay auth + catalog ──────────────────────────────────────────────────
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [session, setSession] = React.useState<SessionInfo | null>(null);
  const authed = session !== null;
  const [wsState, setWsState] = React.useState<ConnectionState>("disconnected");
  const wsRef = React.useRef<MobileWs | null>(null);
  if (wsRef.current === null) wsRef.current = new MobileWs();
  const [nodes, setNodes] = React.useState<RelayNode[]>([]);
  const [selectedNode, setSelectedNode] = React.useState<string | null>(null);

  // ── §7b bootstrap: pairing code issuance + node-appearance polling ────────
  const [code, setCode] = React.useState<PairingCode | null>(null);
  const [codeStatus, setCodeStatus] = React.useState<string | null>(null);
  const baselineNodes = React.useRef<string[]>([]);

  // ── Phase 11 token issuance (device ↔ node local trust) ──────────────────
  const [pending, setPending] = React.useState<PairingSession | null>(null);

  // ── LAN discovery + local pairing ─────────────────────────────────────────
  const [candidates, setCandidates] = React.useState<LanCandidate[]>([]);
  const [host, setHost] = React.useState("");
  const [probe, setProbe] = React.useState<LanCandidate | null>(null);
  const [trusted, setTrusted] = React.useState<TrustedNode[]>([]);

  // ── Conflict inbox (ADR-0003) ─────────────────────────────────────────────
  const [conflicts, setConflicts] = React.useState<{ file_id: string; versions: number[] }[]>([]);

  // ── Upload ────────────────────────────────────────────────────────────────
  const [uploadStatus, setUploadStatus] = React.useState<string | null>(null);

  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      setDevice(await loadOrCreateDevice());
      setTrusted(await getTrustedNodes());
      // A stored session token restores the signed-in state across launches.
      if (await getSessionToken()) {
        setSession(await relaySession());
      }
    })();
  }, []);

  // Bring the Relay socket up once we have both a session and the device id
  // (the latter is the presence/heartbeat identity). A 4001 close means the
  // session is dead, so drop local auth rather than reconnect-looping.
  React.useEffect(() => {
    const ws = wsRef.current!;
    if (session && device) {
      ws.start(device.device_id, {
        onStateChange: setWsState,
        onAuthError: () => setSession(null),
      });
    } else {
      ws.stop();
      setWsState("disconnected");
    }
    return () => ws.stop();
  }, [session, device]);

  const signIn = React.useCallback(async () => {
    setBusy("signing-in");
    setError(null);
    try {
      if (!device) throw new Error("device identity is not ready");
      await relayLogin(email, password, device);
      setSession(await relaySession());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, email, password]);

  const signOut = React.useCallback(async () => {
    setBusy("signing-out");
    setError(null);
    try {
      // Revokes the server session and clears the keychain token via the SDK
      // adapter; the WS effect then tears the socket down.
      await relayLogout();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSession(null);
      setBusy(null);
    }
  }, []);

  const loadNodes = React.useCallback(async () => {
    if (!authed) return;
    setBusy("loading-nodes");
    setError(null);
    try {
      setNodes(await relayNodes());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [authed]);

  // §7b: mint a bootstrap code, snapshot the current node set, and let the
  // polling effect below detect the node once `nodus node pair` completes.
  const createCode = React.useCallback(async () => {
    if (!authed) return;
    setBusy("creating-code");
    setError(null);
    setNotice(null);
    try {
      baselineNodes.current = (await relayNodes()).map((n) => n.node_id);
      const created = await relayCreatePairingCode();
      setCode(created);
      setCodeStatus("waiting");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [authed]);

  // Poll for a node the baseline did not contain: the browser/mobile side only
  // issues the code, so success is detected by diffing the node catalog.
  React.useEffect(() => {
    if (!code || codeStatus !== "waiting") return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const list = await relayNodes();
          if (cancelled) return;
          setNodes(list);
          const known = new Set(baselineNodes.current);
          if (list.some((n) => !known.has(n.node_id))) {
            setCodeStatus("paired");
          }
        } catch {
          // Transient poll failure: keep waiting rather than aborting.
        }
      })();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [code, codeStatus]);

  // Conflict inbox: the Relay returns per-version `conflict_status`, so no
  // separate endpoint is needed.
  const loadConflicts = React.useCallback(async () => {
    if (!authed) return;
    setBusy("loading-conflicts");
    setError(null);
    try {
      const files: RelayFile[] = await relayFiles();
      setConflicts(
        files
          .map((file) => ({
            file_id: file.file_id,
            versions: file.versions
              .filter((v) => v.conflict_status === "flagged")
              .map((v) => v.version_number)
              .sort((a, b) => a - b),
          }))
          .filter((c) => c.versions.length > 0),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [authed]);

  const resolveConflict = React.useCallback(
    async (fileId: string) => {
      if (!authed) return;
      setBusy(`resolving-${fileId}`);
      setError(null);
      setNotice(null);
      try {
        await relayResolveConflict(fileId);
        setNotice("Conflict resolved across your devices and nodes.");
        await loadConflicts();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [authed, loadConflicts],
  );

  const issueToken = React.useCallback(async () => {
    if (!device || !authed || !selectedNode) return;
    setBusy("issuing-token");
    setError(null);
    setNotice(null);
    try {
      await relayRegisterDevice(device);
      setPending(await relayCreatePairingSession(selectedNode, device.device_id));
      setNotice("Token issued — finish locally to pair this device.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, authed, selectedNode]);

  // Pick a file and run the shared Path C uploader against the selected node
  // (or the primary). Shards are encrypted, announced to the Relay, and sealed
  // to every recipient via the injected upload deps.
  const uploadPicked = React.useCallback(async () => {
    if (!device) return;
    const target =
      selectedNode ?? nodes.find((n) => n.is_primary)?.node_id ?? nodes[0]?.node_id;
    if (!target) {
      setError("Load your nodes and select a target first.");
      return;
    }

    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (picked.canceled || !picked.assets?.[0]) return;
    const asset = picked.assets[0];

    setBusy("uploading");
    setError(null);
    setNotice(null);
    setUploadStatus("measuring…");
    try {
      const result = await uploadFile({
        source: fileUriSource(asset.uri, asset.name ?? "upload.bin", asset.size ?? 0),
        originId: device.device_id,
        targetNode: target,
        sourceDevice: device.device_id,
        deps: createMobileUploadDeps(wsRef.current!, device),
        onProgress: (event) =>
          setUploadStatus(`${event.phase} · shard ${event.completedShards}/${event.totalShards}`),
      });
      setUploadStatus(`done · ${result.shardCount} shard(s) · ${result.versionHash.slice(0, 12)}…`);
      setNotice("Upload complete.");
    } catch (err) {
      setUploadStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, selectedNode, nodes]);

  const scan = React.useCallback(async () => {
    setBusy("scanning");
    setError(null);
    setNotice(null);
    try {
      const result = await discoverNodes();
      setCandidates(result.candidates);
      if (!result.permitted) {
        // ADR-0004: say explicitly that local transfer is unavailable, then
        // fall back to the Relay — an empty list alone would read as "no nodes".
        setNotice(
          "Local network access is off, so Wi-Fi pairing is unavailable — transfers will use the Relay. Enable local access and rescan to pair directly.",
        );
      } else if (result.method === "mdns") {
        setNotice(`Found ${result.candidates.length} node(s) via mDNS.`);
      } else {
        setNotice("LAN sweep done. Pick a node below or enter a host manually.");
      }
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
        <Button
          title={authed ? "Signed in" : "Sign in"}
          onPress={() => void signIn()}
          disabled={!device || busy !== null || authed}
        />
        {authed && (
          <>
            <Text style={styles.hint}>Relay socket: {wsState}</Text>
            <View style={styles.spacer} />
            <Button title="Sign out" onPress={() => void signOut()} disabled={busy !== null} />
          </>
        )}
      </Section>

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
              {n.node_id.slice(0, 12)}…{n.is_primary ? " (primary)" : ""} — {n.status}
            </Text>
          </View>
        ))}
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

      <Section title="6 · Upload a file">
        <Button
          title="Pick and upload"
          onPress={() => void uploadPicked()}
          disabled={!authed || !device || busy !== null}
        />
        {uploadStatus && <Text style={styles.hint}>{uploadStatus}</Text>}
        <Text style={styles.hint}>
          Uploads to {selectedNode ? "the selected node" : "the primary node"} and seals the key to
          all your devices and nodes.
        </Text>
      </Section>

      <Section title="Trusted nodes (this device)">
        {trusted.length === 0 && <Text style={styles.hint}>Nothing paired yet.</Text>}
        {trusted.map((t) => (
          <Text key={t.node_id} style={styles.hint}>
            {t.node_id.slice(0, 12)}… @ {t.host} — paired {t.paired_at}
          </Text>
        ))}
      </Section>

      <Section title="Conflicts (ADR-0003)">
        <Button title="Load conflicts" onPress={() => void loadConflicts()} disabled={!authed || busy !== null} />
        {conflicts.length === 0 && <Text style={styles.hint}>No unresolved conflicts.</Text>}
        {conflicts.map((c) => (
          <View key={c.file_id} style={styles.radioRow}>
            <Text style={styles.hint}>
              {c.file_id.slice(0, 12)}… · version{c.versions.length === 1 ? "" : "s"} {c.versions.join(", ")}
            </Text>
            <Button
              title={busy === `resolving-${c.file_id}` ? "Resolving…" : "Resolve"}
              onPress={() => void resolveConflict(c.file_id)}
              disabled={busy !== null}
            />
          </View>
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
  code: {
    marginTop: 8,
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 2,
    color: "#111",
  },
  spacer: { height: 8 },
  error: { color: "#c0392b", marginTop: 8 },
  ok: { color: "#27ae60", marginTop: 8 },
});
