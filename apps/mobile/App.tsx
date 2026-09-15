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
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import {
  Alert,
  AppState,
  Button,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { SHARD_SIZE_BYTES } from "@repo/core";
import type { ConnectionState } from "@repo/relay-client";
import {
  downloadFile,
  listConflicts,
  toCatalogEntry,
  uploadFile,
  type ConflictEntry,
  type SessionInfo,
} from "@repo/sdk";
import type { TransferPath } from "@repo/transfer-manager";
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
  relayDevices,
  relayEnvelopeExport,
  relayEnvelopeSummary,
  relayFiles,
  relayFolders,
  relayLogin,
  relayLogout,
  relayNodes,
  relayPingDevice,
  relayPingNode,
  relayRegisterDevice,
  relayPurgeTombstone,
  relayResolveConflict,
  relayRestoreTombstone,
  relayRevokeDevice,
  relaySession,
  relayTombstones,
  type PairingCode,
  type PairingSession,
  type EnvelopeSummary,
  type RelayDevice,
  type RelayFile,
  type RelayFolder,
  type RelayNode,
  type RelayTombstone,
} from "./src/relay";
import { MobileWs } from "./src/ws";
import {
  createMobileTransferManager,
  type MobileTransferManager,
} from "./src/transfer/manager";
import { createMobileUploadDeps } from "./src/upload/deps";
import { fileUriSource } from "./src/upload/source";
import { mobileDownloadDeps } from "./src/download/deps";
import { fetchMobileFileKey } from "./src/download/keys";
import { decryptFileNames, decryptFolderNames, decryptTombstoneNames } from "./src/download/names";
import { mobileFileMutations } from "./src/files/mutations";
import { mobileFolderMutations } from "./src/folders/mutations";
import { mobileRecoveryClient } from "./src/recovery/client";
import { rotateRecoveryKey } from "./src/recovery/rotate";
import { sqliteRecoveryStore } from "./src/recovery/store";
import { registerBackgroundSync } from "./src/background/sync";
import { saveAndShare } from "./src/download/save";
import { loadOrCreateDevice } from "./src/storage";
import { getPreference, setPreference } from "./src/store/preferences";
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
  const [devices, setDevices] = React.useState<RelayDevice[]>([]);

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
  const [conflicts, setConflicts] = React.useState<ConflictEntry[]>([]);

  // ── Upload ────────────────────────────────────────────────────────────────
  const [uploadStatus, setUploadStatus] = React.useState<string | null>(null);
  const [lastPath, setLastPath] = React.useState<TransferPath | null>(null);
  const [transferManager, setTransferManager] = React.useState<MobileTransferManager | null>(null);

  // ── Download ──────────────────────────────────────────────────────────────
  const [files, setFiles] = React.useState<RelayFile[]>([]);
  const [fileNames, setFileNames] = React.useState<Record<string, string | null>>({});
  const [downloadStatus, setDownloadStatus] = React.useState<string | null>(null);
  /** New name for the Rename action on a file row. */
  const [fileNameInput, setFileNameInput] = React.useState("");

  // ── Tombstones (soft-delete) ──────────────────────────────────────────────
  const [tombstones, setTombstones] = React.useState<RelayTombstone[]>([]);
  const [tombstoneNames, setTombstoneNames] = React.useState<Record<string, string | null>>({});

  // ── Folders ───────────────────────────────────────────────────────────────
  const [folders, setFolders] = React.useState<RelayFolder[]>([]);
  const [folderNames, setFolderNames] = React.useState<Record<string, string | null>>({});
  const [folderNameInput, setFolderNameInput] = React.useState("");
  /** Current folder for the browser; null is the root. */
  const [currentFolderId, setCurrentFolderId] = React.useState<string | null>(null);

  // ── Settings ──────────────────────────────────────────────────────────────
  const [shardSizeBytes, setShardSizeBytes] = React.useState<number>(SHARD_SIZE_BYTES);

  // ── Recovery (ADR-0002) ───────────────────────────────────────────────────
  const [recoveryPhraseInput, setRecoveryPhraseInput] = React.useState("");

  // ── Security: key-envelope coverage ───────────────────────────────────────
  const [envelopeSummary, setEnvelopeSummary] = React.useState<EnvelopeSummary[]>([]);
  const [securityStatus, setSecurityStatus] = React.useState<string | null>(null);
  /** Revealed recovery phrase, or null when hidden/not loaded. */
  const [revealedPhrase, setRevealedPhrase] = React.useState<string | null>(null);

  // ── Foreground gate (ADR-0004: Path A is foreground-only) ─────────────────
  const appActiveRef = React.useRef(true);

  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      setDevice(await loadOrCreateDevice());
      setTrusted(await getTrustedNodes());
      // Restore the shard-size preference (falls back to the 8 MiB default).
      const storedShardSize = await getPreference("shardSizeBytes");
      if (storedShardSize) setShardSizeBytes(Number(storedShardSize) || SHARD_SIZE_BYTES);
      // A stored session token restores the signed-in state across launches.
      if (await getSessionToken()) {
        setSession(await relaySession());
      }
    })();
  }, []);

  // Register the periodic background queue drain (Phase 17); best-effort and
  // unavailable on some platforms, so a failure is ignored.
  React.useEffect(() => {
    void registerBackgroundSync().catch(() => undefined);
  }, []);

  // Track foreground/background so direct LAN transfer is only attempted while
  // the app is active (ADR-0004). The transfer manager reads this live.
  React.useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      appActiveRef.current = state === "active";
    });
    return () => sub.remove();
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
      // The socket is stopped and has no callback to report it, so reflect the
      // reset directly. This is a one-shot transition on sign-out, not a loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWsState("disconnected");
    }
    return () => ws.stop();
  }, [session, device]);

  // Build the transfer manager once authed: it hydrates the SQLite queue/path
  // cache and owns the WebRTC sessions, so it must be torn down on sign-out.
  React.useEffect(() => {
    let cancelled = false;
    let created: MobileTransferManager | null = null;
    if (session && device) {
      void (async () => {
        try {
          const tm = await createMobileTransferManager(device, wsRef.current!, {
            canAttemptLocal: () => appActiveRef.current,
          });
          if (cancelled) {
            tm.close();
            return;
          }
          created = tm;
          setTransferManager(tm);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    } else {
      // Sign-out tear-down: clear once so no stale manager is used.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTransferManager(null);
    }
    return () => {
      cancelled = true;
      created?.close();
      setTransferManager(null);
    };
  }, [session, device]);

  // When the Relay socket comes back, retry the shards parked in the Path D
  // queue. The manager's connectivity hook is what actually drains them.
  React.useEffect(() => {
    if (wsState === "connected" && transferManager) {
      transferManager.localQueue.notifyConnectivityRestored();
    }
  }, [wsState, transferManager]);

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

  const chooseShardSize = React.useCallback((bytes: number) => {
    setShardSizeBytes(bytes);
    // Persist so the choice survives a restart; the uploader reads it per upload.
    void setPreference("shardSizeBytes", String(bytes));
  }, []);

  // Recover a lost device from the phrase: prove it to the Relay, register this
  // device, then unlock the account's recovery-sealed file/folder keys.
  const recoverAccount = React.useCallback(async () => {
    if (!device) return;
    const phrase = recoveryPhraseInput.trim();
    if (!email.trim() || !phrase) {
      setError("Enter your account email and recovery phrase.");
      return;
    }
    setBusy("recovering");
    setError(null);
    setNotice(null);
    try {
      const client = mobileRecoveryClient();
      const result = await client.recover(email, phrase, device);
      if (!result.ok || !result.session) throw new Error(result.error ?? "recovery failed");
      // Keep the phrase locally (revealable on Security) before unlocking keys.
      await client.save(result.session.account_id, phrase);
      const unlocked = await client.materialize(phrase);
      // The native adapter captured the session token from the recover response.
      setSession(result.session);
      setRecoveryPhraseInput("");
      setNotice(
        `Recovered. Unlocked ${unlocked.files} file and ${unlocked.folders} folder key(s).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, email, recoveryPhraseInput]);

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

  const loadDevices = React.useCallback(async () => {
    if (!authed) return;
    setBusy("loading-devices");
    setError(null);
    try {
      setDevices(await relayDevices());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [authed]);

  const revokeDevice = React.useCallback(
    (target: RelayDevice) => {
      const isSelf = device?.device_id === target.device_id;
      Alert.alert(
        "Revoke device",
        isSelf
          ? "This is the current device. Revoking it signs you out immediately."
          : `Revoke ${target.display_name ?? `${target.device_id.slice(0, 12)}…`}? It loses access to new key envelopes.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Revoke",
            style: "destructive",
            onPress: () => {
              void (async () => {
                setBusy(`revoking-${target.device_id}`);
                setError(null);
                setNotice(null);
                try {
                  await relayRevokeDevice(target.device_id);
                  if (isSelf) {
                    setSession(null);
                  } else {
                    setDevices(await relayDevices());
                  }
                  setNotice("Device revoked.");
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(null);
                }
              })();
            },
          },
        ],
      );
    },
    [device],
  );

  const pingDevice = React.useCallback(async (target: RelayDevice) => {
    setBusy(`pinging-${target.device_id}`);
    setError(null);
    setNotice(null);
    try {
      await relayPingDevice(target.device_id);
      setNotice("Ping sent — see the device's status.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const pingNode = React.useCallback(async (target: RelayNode) => {
    setBusy(`pinging-node-${target.node_id}`);
    setError(null);
    setNotice(null);
    try {
      await relayPingNode(target.node_id);
      setNotice("Ping sent to node — see its status.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

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
  // separate endpoint is needed. Derivation is shared with web via the SDK,
  // with the mobile FEK resolver injected for name decryption.
  const loadConflicts = React.useCallback(async () => {
    if (!authed) return;
    setBusy("loading-conflicts");
    setError(null);
    try {
      const files: RelayFile[] = await relayFiles();
      setConflicts(
        await listConflicts({
          listCatalog: async () => files.map(toCatalogEntry),
          resolveFileKey: (fileId) =>
            device ? fetchMobileFileKey(device, fileId) : Promise.resolve(null),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [authed, device]);

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
        parentFolderId: currentFolderId,
        shardSizeBytes,
        deps: createMobileUploadDeps(wsRef.current!, device, transferManager, setLastPath),
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
  }, [device, selectedNode, nodes, transferManager, shardSizeBytes, currentFolderId]);

  const loadFiles = React.useCallback(async () => {
    if (!authed) return;
    setBusy("loading-files");
    setError(null);
    try {
      const list = await relayFiles();
      setFiles(list);
      // Decrypt display names where this device can open the file's key
      // envelope; failures fall back to the id in the list.
      setFileNames(device ? await decryptFileNames(device, list) : {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [authed, device]);

  const loadFolders = React.useCallback(async () => {
    if (!authed) return;
    setBusy("loading-folders");
    setError(null);
    try {
      const list = await relayFolders();
      setFolders(list);
      setFolderNames(device ? await decryptFolderNames(device, list) : {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [authed, device]);

  const createFolder = React.useCallback(async () => {
    const name = folderNameInput.trim();
    if (!device || !name) return;
    setBusy("creating-folder");
    setError(null);
    setNotice(null);
    try {
      // Create inside the folder currently open in the browser.
      await mobileFolderMutations(wsRef.current!, device, session).create(name, currentFolderId);
      setFolderNameInput("");
      await loadFolders();
      setNotice("Folder created.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, session, folderNameInput, currentFolderId, loadFolders]);

  const renameFolder = React.useCallback(
    async (folder: RelayFolder) => {
      const name = folderNameInput.trim();
      if (!device || !name) return;
      setBusy(`renaming-${folder.folder_id}`);
      setError(null);
      setNotice(null);
      try {
        await mobileFolderMutations(wsRef.current!, device, session).rename(
          folder.folder_id,
          folder.parent_folder_id,
          name,
        );
        setFolderNameInput("");
        await loadFolders();
        setNotice("Folder renamed.");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [device, session, folderNameInput, loadFolders],
  );

  const deleteFolder = React.useCallback(
    (folder: RelayFolder) => {
      Alert.alert("Delete folder", "Soft-delete this folder? It can be restored from Deleted files.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              if (!device) return;
              setBusy(`deleting-${folder.folder_id}`);
              setError(null);
              setNotice(null);
              try {
                await mobileFolderMutations(wsRef.current!, device, session).remove(folder.folder_id);
                await loadFolders();
                setNotice("Folder deleted.");
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(null);
              }
            })();
          },
        },
      ]);
    },
    [device, session, loadFolders],
  );

  // Download the newest version, decrypt, and hand to the share sheet.
  const downloadOne = React.useCallback(
    async (file: RelayFile) => {
      if (!device) return;
      const latest = [...file.versions].sort((a, b) => b.version_number - a.version_number)[0];
      if (!latest) {
        setError("file has no versions");
        return;
      }
      setBusy(`downloading-${file.file_id}`);
      setError(null);
      setNotice(null);
      setDownloadStatus("decrypting…");
      try {
        const result = await downloadFile({
          fileId: file.file_id,
          versionNumber: latest.version_number,
          shardCount: latest.shard_count,
          encryptedName: file.encrypted_name,
          expectedVersionHash: latest.version_hash,
          deps: mobileDownloadDeps(device),
        });
        const name = result.name ?? `${file.file_id}.bin`;
        setDownloadStatus(`saving ${name}…`);
        await saveAndShare(result.data, name);
        setDownloadStatus(`downloaded ${name} (${result.data.length} bytes)`);
        setNotice("Download complete.");
      } catch (err) {
        setDownloadStatus(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [device],
  );

  const renameFile = React.useCallback(
    async (file: RelayFile) => {
      const name = fileNameInput.trim();
      if (!device || !name) return;
      setBusy(`renaming-file-${file.file_id}`);
      setError(null);
      setNotice(null);
      try {
        await mobileFileMutations(wsRef.current!, device).rename(file, name);
        setFileNameInput("");
        await loadFiles();
        setNotice("File renamed.");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [device, fileNameInput, loadFiles],
  );

  const moveFile = React.useCallback(
    async (file: RelayFile) => {
      if (!device) return;
      setBusy(`moving-file-${file.file_id}`);
      setError(null);
      setNotice(null);
      try {
        // Move into the folder currently open in the browser.
        await mobileFileMutations(wsRef.current!, device).move(file, currentFolderId);
        await loadFiles();
        setNotice("File moved.");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [device, currentFolderId, loadFiles],
  );

  const deleteFile = React.useCallback(
    (file: RelayFile) => {
      Alert.alert("Delete file", "Soft-delete this file? It can be restored from Deleted files.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              if (!device) return;
              setBusy(`deleting-file-${file.file_id}`);
              setError(null);
              setNotice(null);
              try {
                await mobileFileMutations(wsRef.current!, device).remove(file.file_id);
                await loadFiles();
                setNotice("File deleted.");
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(null);
              }
            })();
          },
        },
      ]);
    },
    [device, loadFiles],
  );

  const loadTombstones = React.useCallback(async () => {
    if (!authed) return;
    setBusy("loading-tombstones");
    setError(null);
    try {
      const list = await relayTombstones();
      setTombstones(list);
      setTombstoneNames(device ? await decryptTombstoneNames(device, list) : {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [authed, device]);

  const restoreTombstone = React.useCallback(
    async (item: RelayTombstone) => {
      setBusy(`restoring-${item.entity_id}`);
      setError(null);
      setNotice(null);
      try {
        await relayRestoreTombstone(item.entity_type, item.entity_id);
        setNotice("Restored across your nodes.");
        await loadTombstones();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [loadTombstones],
  );

  const purgeTombstone = React.useCallback(
    (item: RelayTombstone) => {
      Alert.alert(
        "Delete permanently",
        "This removes the data from every storage node and cannot be undone.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              void (async () => {
                setBusy(`purging-${item.entity_id}`);
                setError(null);
                setNotice(null);
                try {
                  await relayPurgeTombstone(item.entity_type, item.entity_id);
                  setNotice("Permanent delete requested.");
                  await loadTombstones();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(null);
                }
              })();
            },
          },
        ],
      );
    },
    [loadTombstones],
  );

  const loadEnvelopes = React.useCallback(async () => {
    if (!authed) return;
    setBusy("loading-envelopes");
    setError(null);
    try {
      setEnvelopeSummary(await relayEnvelopeSummary());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [authed]);

  // Download the ciphertext-only envelope backup and share it for safekeeping.
  const exportEnvelopes = React.useCallback(async () => {
    if (!authed) return;
    setBusy("exporting-envelopes");
    setError(null);
    setNotice(null);
    try {
      const backup = await relayEnvelopeExport();
      const bytes = new TextEncoder().encode(JSON.stringify(backup, null, 2));
      setSecurityStatus("opening share sheet…");
      await saveAndShare(bytes, `nodus-envelopes-${Date.now()}.json`);
      setSecurityStatus("envelope backup shared");
      setNotice("Envelope backup ready.");
    } catch (err) {
      setSecurityStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [authed]);

  const revealPhrase = React.useCallback(async () => {
    if (!session) return;
    setBusy("revealing-phrase");
    setError(null);
    setNotice(null);
    try {
      const phrase = await sqliteRecoveryStore.load(session.account_id);
      setRevealedPhrase(phrase);
      if (!phrase) setNotice("No recovery phrase is stored on this device for this account.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [session]);

  const copyPhrase = React.useCallback(async () => {
    if (!revealedPhrase) return;
    await Clipboard.setStringAsync(revealedPhrase);
    setNotice("Recovery phrase copied to the clipboard.");
  }, [revealedPhrase]);

  // Regenerate the recovery key: enroll the new public key, re-seal every key
  // this device can open, and reveal the new phrase once.
  const rotateRecovery = React.useCallback(() => {
    if (!device || !session) return;
    Alert.alert(
      "Regenerate recovery key",
      "This replaces your recovery phrase and re-seals your keys to the new one. Record the new phrase immediately.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Regenerate",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setBusy("rotating-recovery");
              setError(null);
              setNotice(null);
              setSecurityStatus(null);
              try {
                const { phrase, resealed } = await rotateRecoveryKey(wsRef.current!, device, session);
                // Show the new phrase so it can be recorded before it is hidden.
                setRevealedPhrase(phrase);
                setSecurityStatus(
                  `New phrase shown above. Re-sealed ${resealed.files} file / ${resealed.folders} folder key(s), skipped ${resealed.skipped}.`,
                );
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(null);
              }
            })();
          },
        },
      ],
    );
  }, [device, session]);

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

  // Folder browser projections: children of the current folder and the path
  // from root, so navigation and uploads agree on "where am I".
  const folderLabel = (f: RelayFolder) => folderNames[f.folder_id] ?? `${f.folder_id.slice(0, 12)}…`;
  const visibleFolders = folders.filter((f) => (f.parent_folder_id ?? null) === currentFolderId);
  const visibleFiles = files.filter((f) => (f.parent_folder_id ?? null) === currentFolderId);
  const folderTrail = (() => {
    const trail: RelayFolder[] = [];
    const byId = new Map(folders.map((f) => [f.folder_id, f]));
    let id = currentFolderId;
    for (let guard = 0; id && guard < 64; guard += 1) {
      const folder = byId.get(id);
      if (!folder) break;
      trail.unshift(folder);
      id = folder.parent_folder_id;
    }
    return trail;
  })();

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
              {n.display_name ?? `${n.node_id.slice(0, 12)}…`}
              {n.is_primary ? " (primary)" : ""} — {n.status}
            </Text>
            <Button
              title={busy === `pinging-node-${n.node_id}` ? "Pinging…" : "Ping"}
              onPress={() => void pingNode(n)}
              disabled={busy !== null || n.status !== "ACTIVE"}
            />
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
        {lastPath && <Text style={styles.hint}>Last shard path: {transferPathLabel(lastPath)}</Text>}
        <Text style={styles.hint}>
          Uploads to {selectedNode ? "the selected node" : "the primary node"} and seals the key to
          all your devices and nodes.
        </Text>
      </Section>

      <Section title="7 · Download a file">
        <Button title="Load files" onPress={() => void loadFiles()} disabled={!authed || busy !== null} />
        <Text style={styles.hint}>
          In: Root{folderTrail.map((f) => ` / ${folderLabel(f)}`).join("")}
        </Text>
        {visibleFiles.length === 0 && <Text style={styles.hint}>No files here.</Text>}
        {visibleFiles.map((f) => (
          <View key={f.file_id} style={styles.radioRow}>
            <Text style={styles.hint}>
              {fileNames[f.file_id] ?? `${f.file_id.slice(0, 12)}…`} · {f.versions.length} version
              {f.versions.length === 1 ? "" : "s"} ·{" "}
              {toCatalogEntry(f).storage_status ?? "unknown"}
              {toCatalogEntry(f).conflicted_versions.length > 0 ? " · conflict" : ""}
            </Text>
            <View style={styles.buttonRow}>
              <Button
                title={busy === `downloading-${f.file_id}` ? "Downloading…" : "Download"}
                onPress={() => void downloadOne(f)}
                disabled={busy !== null}
              />
              <Button
                title={busy === `renaming-file-${f.file_id}` ? "Renaming…" : "Rename"}
                onPress={() => void renameFile(f)}
                disabled={busy !== null || fileNameInput.trim() === ""}
              />
              {(f.parent_folder_id ?? null) !== currentFolderId && (
                <Button
                  title={busy === `moving-file-${f.file_id}` ? "Moving…" : "Move here"}
                  onPress={() => void moveFile(f)}
                  disabled={busy !== null}
                />
              )}
              <Button
                title={busy === `deleting-file-${f.file_id}` ? "Deleting…" : "Delete"}
                onPress={() => deleteFile(f)}
                disabled={busy !== null}
              />
            </View>
          </View>
        ))}
        <TextInput
          style={styles.input}
          value={fileNameInput}
          onChangeText={setFileNameInput}
          placeholder="new file name (for Rename)"
        />
        {downloadStatus && <Text style={styles.hint}>{downloadStatus}</Text>}
      </Section>

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
            </View>
          </View>
        ))}
      </Section>

      <Section title="9 · Deleted files">
        <Button
          title="Load deleted"
          onPress={() => void loadTombstones()}
          disabled={!authed || busy !== null}
        />
        {tombstones.length === 0 && <Text style={styles.hint}>Nothing soft-deleted.</Text>}
        {tombstones.map((t) => (
          <View key={`${t.entity_type}:${t.entity_id}`} style={styles.radioRow}>
            <Text style={styles.hint}>
              {tombstoneNames[t.entity_id] ?? `${t.entity_id.slice(0, 12)}…`} · {t.entity_type} ·
              purge after {t.purge_after.slice(0, 10)}
              {t.purge_requested_at ? " · purging" : ""}
            </Text>
            <View style={styles.buttonRow}>
              <Button
                title={busy === `restoring-${t.entity_id}` ? "Restoring…" : "Restore"}
                onPress={() => void restoreTombstone(t)}
                disabled={busy !== null}
              />
              <Button
                title={busy === `purging-${t.entity_id}` ? "Deleting…" : "Delete"}
                onPress={() => purgeTombstone(t)}
                disabled={busy !== null}
              />
            </View>
          </View>
        ))}
      </Section>

      <Section title="10 · Settings">
        <Text style={styles.hint}>
          Shard size: {Math.round(shardSizeBytes / (1024 * 1024))} MB (applies to new uploads)
        </Text>
        <View style={styles.buttonRow}>
          {[4, 8, 16].map((mb) => (
            <Button
              key={mb}
              title={shardSizeBytes === mb * 1024 * 1024 ? `${mb} MB ✓` : `${mb} MB`}
              onPress={() => chooseShardSize(mb * 1024 * 1024)}
              disabled={busy !== null}
            />
          ))}
        </View>
      </Section>

      <Section title="11 · Folders">
        <Button
          title="Load folders"
          onPress={() => void loadFolders()}
          disabled={!authed || busy !== null}
        />
        <Text style={styles.hint}>
          In: Root{folderTrail.map((f) => ` / ${folderLabel(f)}`).join("")}
        </Text>
        {currentFolderId !== null && (
          <Button
            title="◂ Up"
            onPress={() => {
              const parent = folders.find((f) => f.folder_id === currentFolderId)?.parent_folder_id ?? null;
              setCurrentFolderId(parent);
            }}
            disabled={busy !== null}
          />
        )}
        {visibleFolders.length === 0 && <Text style={styles.hint}>No subfolders here.</Text>}
        {visibleFolders.map((f) => (
          <View key={f.folder_id} style={styles.radioRow}>
            <Text style={styles.hint}>{folderLabel(f)}</Text>
            <View style={styles.buttonRow}>
              <Button title="Open" onPress={() => setCurrentFolderId(f.folder_id)} disabled={busy !== null} />
              <Button
                title={busy === `renaming-${f.folder_id}` ? "Renaming…" : "Rename"}
                onPress={() => void renameFolder(f)}
                disabled={busy !== null || folderNameInput.trim() === ""}
              />
              <Button
                title={busy === `deleting-${f.folder_id}` ? "Deleting…" : "Delete"}
                onPress={() => deleteFolder(f)}
                disabled={busy !== null}
              />
            </View>
          </View>
        ))}
        <TextInput
          style={styles.input}
          value={folderNameInput}
          onChangeText={setFolderNameInput}
          placeholder="new subfolder name (for Create / Rename)"
        />
        <Button
          title={busy === "creating-folder" ? "Creating…" : "Create here"}
          onPress={() => void createFolder()}
          disabled={!authed || busy !== null || folderNameInput.trim() === ""}
        />
      </Section>

      <Section title="12 · Recover account">
        <Text style={styles.hint}>
          Uses the account email above and your 24-word recovery phrase (ADR-0002).
        </Text>
        <TextInput
          style={styles.input}
          value={recoveryPhraseInput}
          onChangeText={setRecoveryPhraseInput}
          placeholder="recovery phrase (24 words)"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        <Button
          title={busy === "recovering" ? "Recovering…" : "Recover account"}
          onPress={() => void recoverAccount()}
          disabled={busy !== null || !email.trim() || !recoveryPhraseInput.trim()}
        />
      </Section>

      <Section title="13 · Security">
        <Button
          title="Load envelope coverage"
          onPress={() => void loadEnvelopes()}
          disabled={!authed || busy !== null}
        />
        {envelopeSummary.length === 0 && (
          <Text style={styles.hint}>No envelope coverage loaded.</Text>
        )}
        {envelopeSummary.map((s) => (
          <Text key={`${s.recipient_kind}:${s.recipient_id}`} style={styles.hint}>
            {s.recipient_kind} {s.recipient_id.slice(0, 12)}… · {s.file_count} file /{" "}
            {s.folder_count} folder
            {s.last_updated ? ` · ${s.last_updated.slice(0, 10)}` : ""}
          </Text>
        ))}
        <View style={styles.spacer} />
        <Button
          title={busy === "exporting-envelopes" ? "Exporting…" : "Export envelope backup"}
          onPress={() => void exportEnvelopes()}
          disabled={!authed || busy !== null}
        />
        {securityStatus && <Text style={styles.hint}>{securityStatus}</Text>}

        <View style={styles.spacer} />
        <Button
          title={revealedPhrase ? "Hide recovery phrase" : "Reveal recovery phrase"}
          onPress={() => (revealedPhrase ? setRevealedPhrase(null) : void revealPhrase())}
          disabled={!authed || busy !== null}
        />
        {revealedPhrase && (
          <>
            <Text style={styles.hint}>
              Anyone with these words can recover the account. Keep them offline.
            </Text>
            <Text style={styles.code}>{revealedPhrase}</Text>
            <Button title="Copy phrase" onPress={() => void copyPhrase()} disabled={busy !== null} />
          </>
        )}

        <View style={styles.spacer} />
        <Button
          title={busy === "rotating-recovery" ? "Regenerating…" : "Regenerate recovery key"}
          onPress={() => rotateRecovery()}
          disabled={!authed || busy !== null}
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

      <Section title="Conflicts (ADR-0003)">
        <Button title="Load conflicts" onPress={() => void loadConflicts()} disabled={!authed || busy !== null} />
        {conflicts.length === 0 && <Text style={styles.hint}>No unresolved conflicts.</Text>}
        {conflicts.map((c) => (
          <View key={c.fileId} style={styles.radioRow}>
            <Text style={styles.hint}>
              {c.name} · version{c.versions.length === 1 ? "" : "s"} {c.versions.join(", ")}
            </Text>
            <Button
              title={busy === `resolving-${c.fileId}` ? "Resolving…" : "Resolve"}
              onPress={() => void resolveConflict(c.fileId)}
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

/** Human label for a transfer path (mirrors the web TransferPathBanner text). */
function transferPathLabel(path: TransferPath): string {
  switch (path) {
    case "local_signaling":
      return "Direct LAN (local signaling)";
    case "relay_signaling":
      return "Direct (Relay signaling)";
    case "buffer_relay":
      return "Relay buffer";
    case "local_queue":
      return "Queued on device";
    default:
      return path;
  }
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
  buttonRow: { flexDirection: "row", justifyContent: "space-between", marginVertical: 4 },
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
