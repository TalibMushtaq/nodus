// Nodus mobile app state and actions, extracted from the original monolithic
// App component so the navigator screens can stay presentational. Screens read
// this via `useApp()` (see context.tsx); none of the networking, SQLite, or
// crypto logic moved.
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
import * as Network from "expo-network";
import { Alert, AppState } from "react-native";

import { SHARD_SIZE_BYTES } from "@repo/core";
import type { ConnectionState } from "@repo/relay-client";
import {
  downloadFile,
  encryptionPublicKeyBytes,
  listConflicts,
  toCatalogEntry,
  uploadFile,
  DownloadCancelledError,
  type ConflictEntry,
  type DownloadPhase,
  type DownloadTransport,
  type SessionInfo,
  type StoredEncryptionIdentity,
  type UploadProgressEvent,
} from "@repo/sdk";
import type { TransferPath } from "@repo/transfer-manager";
import {
  fetchAdvertisement,
  NodeClient,
  NodeClientError,
  nodusBaseUrl,
} from "@repo/relay-client/local-discovery";
import {
  identityPrivateKey,
  identityPublicKey,
  signDeviceMessage,
  type StoredDeviceIdentity,
} from "@repo/relay-client/device-identity";

import { discoverNodes, probeHost, type LanCandidate } from "../discovery";
import {
  getSessionToken,
  relayActivities,
  relayChangePassword,
  relayCreatePairingCode,
  relayCreatePairingSession,
  relayDevices,
  relayEnvelopeExport,
  relayEnvelopeSummary,
  relayFiles,
  relayFolders,
  relayLogin,
  relayLogout,
  relayLogoutAll,
  relayNodes,
  relayPingDevice,
  relayPingNode,
  relayRegister,
  relayRegisterDevice,
  relayPurgeTombstone,
  relayResolveConflict,
  relayRestoreTombstone,
  relayRenameDevice,
  relayRenameNode,
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
} from "../relay";
import { MobileWs } from "../ws";
import {
  createMobileTransferManager,
  type MobileTransferManager,
} from "../transfer/manager";
import { createMobileUploadDeps } from "../upload/deps";
import { fileUriSource } from "../upload/source";
import { mobileDownloadDeps } from "../download/deps";
import { fetchMobileFileKey } from "../download/keys";
import { decryptFileNames, decryptFolderNames, decryptTombstoneNames } from "../download/names";
import { mobileFileMutations } from "../files/mutations";
import { mobileFolderMutations } from "../folders/mutations";
import { mobileRecoveryClient } from "../recovery/client";
import { recoverFromNode } from "../recovery/offline";
import { rotateRecoveryKey } from "../recovery/rotate";
import { sqliteRecoveryStore } from "../recovery/store";
import { registerBackgroundSync } from "../background/sync";
import { saveAndShare } from "../download/save";
import { downloadTransportPath } from "../download/transport";
import { loadImagePreview } from "../files/preview";
import { activityLoggedEvent } from "../activity/events";
import { loadNodeActivities } from "../activity/remote";
import { loadOrCreateDevice, loadOrCreateEncryptionIdentity } from "../storage";
import {
  configureNotificationHandler,
  syncPushRegistration,
  unregisterPush,
} from "../notifications";
import { getPreference, setPreference } from "../store/preferences";
import {
  addTrustedNode,
  getTrustedNodes,
  removeTrustedNode,
  type TrustedNode,
} from "../store/trusted-nodes";
import {
  clearTransfers,
  importRemoteActivities,
  listTransfers,
  listUnsyncedTransfers,
  logTransfer,
  markTransfersSynced,
  type TransferLogEntry,
  type TransferLogKind,
} from "../store/transfer-log";
import type { ActivityRecord } from "@repo/protocol";
import { nextOriginSequence } from "../store/sync-state";

/** Local notification toggles; wired to real push in the backend phase. */
export interface NotificationPrefs {
  conflicts: boolean;
  deviceOffline: boolean;
  syncComplete: boolean;
}

const NOTIF_PREF_KEYS: Record<keyof NotificationPrefs, string> = {
  conflicts: "notif.conflicts",
  deviceOffline: "notif.deviceOffline",
  syncComplete: "notif.syncComplete",
};

/**
 * Upload auto-retry budget, mirroring the web client. A transient transport
 * failure aborts the current attempt; re-calling `uploadFile` with the same
 * fileId/version resumes from the persisted per-shard progress, so only the
 * shards that did not land move. Web keeps the File handle in memory; the
 * native source is the on-disk DocumentPicker copy, which is also re-readable,
 * so the retry works the same way here.
 */
const UPLOAD_RETRY_ATTEMPTS = 5;
const UPLOAD_RETRY_BASE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Structured progress for the in-flight upload, so Activity can show bytes. */
export interface UploadProgress {
  fileName: string;
  phase: string;
  completedBytes: number;
  totalBytes: number;
  completedShards: number;
  totalShards: number;
}

/**
 * Structured progress for the in-flight download: the SDK's fetch/verify/
 * decrypt/assemble stages plus byte/shard counts. Mirrors the web download
 * widget so a slow decrypt no longer looks like a hang.
 */
export interface DownloadProgress {
  fileName: string;
  phase: DownloadPhase;
  completedBytes: number;
  totalBytes: number;
  completedShards: number;
  totalShards: number;
  /** Epoch-ms the download started; the basis for average throughput/ETA. */
  startedAt: number;
}

export function useNodusApp() {
  // ── device identity (created on first launch, key output of this app) ────
  const [device, setDevice] = React.useState<StoredDeviceIdentity | null>(null);
  // X25519 encryption identity (ADR-0008): published to the Relay so peers seal
  // key envelopes to it directly.
  const [encryption, setEncryption] = React.useState<StoredEncryptionIdentity | null>(null);

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

  // Inline rename editor shared by the node and device lists. `renaming` marks
  // which row is being edited so only that row renders an input.
  const [renaming, setRenaming] = React.useState<{ kind: "node" | "device"; id: string } | null>(
    null,
  );
  const [renameValue, setRenameValue] = React.useState("");

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
  const [uploadProgress, setUploadProgress] = React.useState<UploadProgress | null>(null);
  const [lastPath, setLastPath] = React.useState<TransferPath | null>(null);
  const [transferManager, setTransferManager] = React.useState<MobileTransferManager | null>(null);

  // ── Download ──────────────────────────────────────────────────────────────
  const [files, setFiles] = React.useState<RelayFile[]>([]);
  const [fileNames, setFileNames] = React.useState<Record<string, string | null>>({});
  const [downloadStatus, setDownloadStatus] = React.useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = React.useState<DownloadProgress | null>(null);
  // Transport that served the newest downloaded shard (LAN / Relay / WebRTC),
  // so the Downloads tab can label how the bytes arrived.
  const [downloadTransport, setDownloadTransport] = React.useState<DownloadTransport | null>(null);
  // Aborts the active download when the user cancels; null between downloads.
  const downloadAbortRef = React.useRef<AbortController | null>(null);
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

  // ── Activity log (device-local; the Relay has no account-wide feed) ───────
  const [activity, setActivity] = React.useState<TransferLogEntry[]>([]);

  // ── Notification preferences (local until the push backend lands) ────────
  const [notificationPrefs, setNotificationPrefsState] = React.useState<NotificationPrefs>({
    conflicts: true,
    deviceOffline: true,
    syncComplete: true,
  });

  // ── Live transfer depth (queued + in-flight shards), for the Activity tab ─
  const [pendingTransfers, setPendingTransfers] = React.useState(0);

  /** Append an action to the device-local log (and the in-memory feed). */
  const logActivity = React.useCallback(
    async (entry: {
      kind: TransferLogKind;
      fileId?: string | null;
      fileName?: string | null;
      detail?: string | null;
      path?: string | null;
      outcome: TransferLogEntry["outcome"];
    }) => {
      try {
        const stored = await logTransfer({
          kind: entry.kind,
          fileId: entry.fileId ?? null,
          fileName: entry.fileName ?? null,
          detail: entry.detail ?? null,
          path: entry.path ?? null,
          outcome: entry.outcome,
        });
        setActivity((prev) => [stored, ...prev].slice(0, 200));
      } catch {
        // Best-effort: a failed log write must never fail the action itself.
      }
    },
    [],
  );

  // Pull the account-wide feed: the Relay when online, else a trusted node over
  // the LAN. Either failure keeps the locally-cached feed. Remote rows are
  // merged into the local store and deduped by activity id.
  const loadActivity = React.useCallback(async () => {
    if (device) {
      let remote: ActivityRecord[] | null = null;
      try {
        remote = await relayActivities();
      } catch {
        try {
          remote = await loadNodeActivities(device);
        } catch {
          remote = null;
        }
      }
      if (remote) await importRemoteActivities(remote);
    }
    setActivity(await listTransfers());
  }, [device]);

  const clearActivity = React.useCallback(async () => {
    await clearTransfers();
    setActivity([]);
  }, []);

  // ── Recovery (ADR-0002) ───────────────────────────────────────────────────
  const [recoveryPhraseInput, setRecoveryPhraseInput] = React.useState("");
  // Registration (Phase 1 parity): the phrase is generated locally, shown once
  // for the user to save, and only its derived public key is sent to the Relay.
  const [signupPhrase, setSignupPhrase] = React.useState<string | null>(null);

  // ── Security: key-envelope coverage ───────────────────────────────────────
  const [envelopeSummary, setEnvelopeSummary] = React.useState<EnvelopeSummary[]>([]);
  const [securityStatus, setSecurityStatus] = React.useState<string | null>(null);
  /** Revealed recovery phrase, or null when hidden/not loaded. */
  const [revealedPhrase, setRevealedPhrase] = React.useState<string | null>(null);

  // ── Foreground gate (ADR-0004: Path A is foreground-only) ─────────────────
  const appActiveRef = React.useRef(true);

  // Node reachability for the transfer chain. Mirrors the Relay catalog into a
  // ref so the manager's long-lived predicate reads fresh state; unknown nodes
  // report online so a not-yet-loaded catalog does not disable direct paths.
  const nodeOnlineRef = React.useRef<Map<string, boolean>>(new Map());

  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      // Foreground notification presentation must be configured before any
      // notification can arrive, so set it as early as possible.
      configureNotificationHandler();
      setDevice(await loadOrCreateDevice());
      setEncryption(await loadOrCreateEncryptionIdentity());
      setTrusted(await getTrustedNodes());
      // Restore the shard-size preference (falls back to the 8 MiB default).
      const storedShardSize = await getPreference("shardSizeBytes");
      if (storedShardSize) setShardSizeBytes(Number(storedShardSize) || SHARD_SIZE_BYTES);
      // Notification toggles default on; only a stored "false" disables one.
      const notifEntries = await Promise.all(
        (Object.keys(NOTIF_PREF_KEYS) as (keyof NotificationPrefs)[]).map(
          async (key) =>
            [key, (await getPreference(NOTIF_PREF_KEYS[key])) !== "false"] as const,
        ),
      );
      setNotificationPrefsState(Object.fromEntries(notifEntries) as unknown as NotificationPrefs);
      // Restore the device-local activity feed.
      setActivity(await listTransfers());
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

  // Keep the transfer chain's offline fast-path in sync with the node catalog.
  React.useEffect(() => {
    for (const node of nodes) nodeOnlineRef.current.set(node.node_id, node.status === "ACTIVE");
  }, [nodes]);

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
            // Unknown nodes default to online (see nodeOnlineRef comment).
            isNodeOnline: (nodeId) => nodeOnlineRef.current.get(nodeId) ?? true,
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

  // Upload locally-recorded activity to the account-wide feed as
  // ACTIVITY_LOGGED events. Runs in the background so an action logged while
  // Activity is closed still reaches the Relay/Node; entries logged offline are
  // retried on reconnect (the effect re-runs when `wsState` flips to connected).
  React.useEffect(() => {
    if (!device || !session || wsState !== "connected") return;
    let cancelled = false;
    let flushing = false;
    const flush = async () => {
      if (flushing || cancelled) return;
      flushing = true;
      try {
        const pending = await listUnsyncedTransfers();
        if (pending.length > 0) {
          const events = [];
          for (const entry of pending) {
            const sequence = await nextOriginSequence(device.device_id);
            events.push(activityLoggedEvent(device.device_id, sequence, entry));
          }
          await wsRef.current!.sendEventBatch(events);
          await markTransfersSynced(pending.map((entry) => entry.id));
        }
      } catch {
        // Best-effort: leave them unsynced and retry on the next tick.
      } finally {
        flushing = false;
      }
    };
    void flush();
    const timer = setInterval(() => void flush(), 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [device, session, wsState]);

  // Surface transfer depth for the Activity tab. The shared manager exposes no
  // change events, so poll cheaply and only re-render when the count changes.
  React.useEffect(() => {
    const read = () =>
      transferManager === null
        ? 0
        : transferManager.manager.activeCount +
          transferManager.manager.queuedCount +
          transferManager.localQueue.size;
    const tick = () =>
      setPendingTransfers((prev) => {
        const next = read();
        return next === prev ? prev : next;
      });
    // Defer the first read out of the effect body so it is not a synchronous
    // setState (which the lint rules correctly flag as a cascading render).
    const initial = setTimeout(tick, 0);
    const timer = transferManager ? setInterval(tick, 3000) : undefined;
    return () => {
      clearTimeout(initial);
      if (timer) clearInterval(timer);
    };
  }, [transferManager]);

  // Register/refresh push delivery whenever the session or the category
  // preferences change. Best-effort (see notifications.ts).
  React.useEffect(() => {
    if (!session) return;
    void syncPushRegistration({
      conflicts: notificationPrefs.conflicts,
      deviceOffline: notificationPrefs.deviceOffline,
      syncComplete: notificationPrefs.syncComplete,
    });
  }, [session, notificationPrefs]);

  const signIn = React.useCallback(async () => {
    setBusy("signing-in");
    setError(null);
    try {
      if (!device) throw new Error("device identity is not ready");
      await relayLogin(email, password, device, encryption?.public_key);
      setSession(await relaySession());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, email, password, encryption]);

  const signOut = React.useCallback(async () => {
    setBusy("signing-out");
    setError(null);
    try {
      // Remove the push token first: it needs the still-valid session, and a
      // signed-out device must stop receiving account notifications.
      await unregisterPush();
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

  const setNotificationPref = React.useCallback(
    (key: keyof NotificationPrefs, value: boolean) => {
      setNotificationPrefsState((prev) => ({ ...prev, [key]: value }));
      // Persisted as "true"/"false"; the mount effect reads them back.
      void setPreference(NOTIF_PREF_KEYS[key], value ? "true" : "false");
    },
    [],
  );

  // Rotate the password. The Relay rotates the session and the adapter stores
  // the fresh token, so this device stays signed in; other sessions are left
  // alone (use logoutAll for that). Returns success so the form can reset.
  const changePassword = React.useCallback(
    async (currentPassword: string, newPassword: string): Promise<boolean> => {
      setBusy("changing-password");
      setError(null);
      setNotice(null);
      try {
        setSession(await relayChangePassword(currentPassword, newPassword));
        setNotice("Password changed.");
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // Revoke every other session; this device's session is rotated and kept.
  const logoutAll = React.useCallback(async () => {
    setBusy("signing-out-others");
    setError(null);
    setNotice(null);
    try {
      setSession(await relayLogoutAll());
      setNotice("Signed out all other devices.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  // Drop local LAN trust for a node (unpair). Local-only: the account still
  // knows the node, so it can be re-paired without a new bootstrap code.
  const unpairTrustedNode = React.useCallback(async (nodeId: string) => {
    setBusy(`unpairing-${nodeId}`);
    setError(null);
    setNotice(null);
    try {
      await removeTrustedNode(nodeId);
      setTrusted(await getTrustedNodes());
      setNotice("Node unpaired on this device.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
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
      const net = await Network.getNetworkStateAsync();
      const online = net.isInternetReachable !== false;

      if (online) {
        const result = await client.recover(email, phrase, device, encryption?.public_key);
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
        return;
      }

      // Offline: recover against a paired LAN Storage Node (ADR-0002 §24). No
      // Relay session is created, so Relay-backed features wait for Internet.
      const offline = await recoverFromNode(phrase, device);
      await client.save(offline.accountId, phrase);
      setTrusted(await getTrustedNodes());
      setRecoveryPhraseInput("");
      setNotice(
        `Recovered offline via node ${offline.nodeId.slice(0, 12)}… Unlocked ${offline.files} file and ${offline.folders} folder key(s). Sign in when online for full access.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, email, recoveryPhraseInput, encryption]);

  // Registration (Phase 1 parity with web). The phrase is generated locally so
  // the UI can show all 24 words before the account exists; only its derived
  // Ed25519 public key is sent to the Relay.
  const beginSignUp = React.useCallback(() => {
    setError(null);
    setNotice(null);
    setSignupPhrase(mobileRecoveryClient().createPhrase());
  }, []);

  const cancelSignUp = React.useCallback(() => setSignupPhrase(null), []);

  const signUp = React.useCallback(async () => {
    if (!device) {
      setError("device identity is not ready");
      return;
    }
    if (!email.trim() || !password) {
      setError("Enter an email and password to create an account.");
      return;
    }
    if (!signupPhrase) {
      setError("Generate your recovery phrase first.");
      return;
    }
    setBusy("creating-account");
    setError(null);
    setNotice(null);
    try {
      const client = mobileRecoveryClient();
      const recoveryPublicKey = client.publicKey(signupPhrase);
      const created = await relayRegister(
        email,
        password,
        device,
        recoveryPublicKey,
        encryption?.public_key,
      );
      // Persist the phrase before leaving the enrollment step so it stays
      // revealable on Security, matching the web registration flow.
      await client.save(created.account_id, signupPhrase);
      setSession(created);
      setSignupPhrase(null);
      setNotice("Account created. Keep your recovery phrase somewhere safe.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, email, password, signupPhrase, encryption]);

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

  // Rename editors for nodes/devices. The Relay PATCH treats an empty name as
  // "clear", so a blank draft is a legitimate submission.
  const beginRename = React.useCallback((kind: "node" | "device", id: string, current: string) => {
    setRenaming({ kind, id });
    setRenameValue(current);
    setError(null);
    setNotice(null);
  }, []);

  const cancelRename = React.useCallback(() => {
    setRenaming(null);
    setRenameValue("");
  }, []);

  const submitRename = React.useCallback(async () => {
    if (!renaming) return;
    setBusy(`renaming-${renaming.id}`);
    setError(null);
    setNotice(null);
    try {
      if (renaming.kind === "node") {
        await relayRenameNode(renaming.id, renameValue.trim());
        setNodes(await relayNodes());
      } else {
        await relayRenameDevice(renaming.id, renameValue.trim());
        setDevices(await relayDevices());
      }
      setRenaming(null);
      setRenameValue("");
      setNotice("Name updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [renaming, renameValue]);

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
    async (fileId: string, keepVersion?: number) => {
      if (!authed) return;
      setBusy(`resolving-${fileId}`);
      setError(null);
      setNotice(null);
      try {
        // `keepVersion` records the chosen side (ADR-0003 addendum); omitting
        // it keeps the previous "acknowledge, newest stays current" behavior.
        await relayResolveConflict(fileId, keepVersion);
        setNotice("Conflict resolved across your devices and nodes.");
        await logActivity({
          kind: "conflict",
          fileId,
          fileName: conflicts.find((c) => c.fileId === fileId)?.name ?? null,
          detail: keepVersion !== undefined ? `kept v${keepVersion}` : null,
          outcome: "complete",
        });
        await loadConflicts();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        await logActivity({
          kind: "conflict",
          fileId,
          fileName: conflicts.find((c) => c.fileId === fileId)?.name ?? null,
          detail: message,
          outcome: "failed",
        });
      } finally {
        setBusy(null);
      }
    },
    [authed, loadConflicts, conflicts, logActivity],
  );

  const issueToken = React.useCallback(async () => {
    if (!device || !authed || !selectedNode) return;
    setBusy("issuing-token");
    setError(null);
    setNotice(null);
    try {
      await relayRegisterDevice(device, encryption?.public_key);
      setPending(await relayCreatePairingSession(selectedNode, device.device_id));
      setNotice("Token issued — finish locally to pair this device.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, authed, selectedNode, encryption]);

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
    setUploadProgress(null);
    const fileName = asset.name ?? "upload.bin";
    // Capture the path the last shard took so the activity row can show it.
    let usedPath: TransferPath | null = null;
    // The uploader allocates the fileId; capturing it from the first progress
    // event lets a retry re-enter the same file/version and resume instead of
    // announcing a duplicate.
    let uploadFileId: string | undefined;
    const source = fileUriSource(asset.uri, fileName, asset.size ?? 0);
    const deps = createMobileUploadDeps(
      wsRef.current!,
      device,
      transferManager,
      (path) => {
        usedPath = path;
        setLastPath(path);
      },
      // Seal the upload to the account recovery key so the phrase can still
      // unlock it after every device is lost.
      session?.recovery_public_key,
    );
    const onProgress = (event: UploadProgressEvent) => {
      if (event.fileId) uploadFileId = event.fileId;
      setUploadStatus(`${event.phase} · shard ${event.completedShards}/${event.totalShards}`);
      setUploadProgress({
        fileName: event.fileName,
        phase: event.phase,
        completedBytes: event.completedBytes,
        totalBytes: event.totalBytes,
        completedShards: event.completedShards,
        totalShards: event.totalShards,
      });
    };

    let uploadError: unknown = null;
    try {
      for (let attempt = 1; attempt <= UPLOAD_RETRY_ATTEMPTS; attempt += 1) {
        try {
          const result = await uploadFile({
            source,
            originId: device.device_id,
            targetNode: target,
            sourceDevice: device.device_id,
            parentFolderId: currentFolderId,
            shardSizeBytes,
            deps,
            // Resume the same file on a retry; a fresh upload lets the SDK
            // allocate the id.
            fileId: uploadFileId,
            versionNumber: uploadFileId ? 1 : undefined,
            onProgress,
          });
          setUploadStatus(`done · ${result.shardCount} shard(s) · ${result.versionHash.slice(0, 12)}…`);
          setNotice("Upload complete.");
          await logActivity({
            kind: "upload",
            fileId: result.fileId,
            fileName,
            detail: `${result.shardCount} shard(s)`,
            path: usedPath,
            outcome: "complete",
          });
          uploadError = null;
          break;
        } catch (err) {
          uploadError = err;
          if (attempt >= UPLOAD_RETRY_ATTEMPTS) break;
          const waitMs = UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1);
          setUploadStatus(`retrying in ${Math.max(1, Math.round(waitMs / 1000))}s…`);
          await sleep(waitMs);
        }
      }
      if (uploadError !== null) {
        throw uploadError;
      }
    } catch (err) {
      setUploadStatus(null);
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      await logActivity({
        kind: "upload",
        fileName,
        detail: message,
        path: usedPath,
        outcome: "failed",
      });
    } finally {
      setUploadProgress(null);
      setBusy(null);
    }
  }, [device, session, selectedNode, nodes, transferManager, shardSizeBytes, currentFolderId, logActivity]);

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
    if (!device || !encryption || !name) return;
    setBusy("creating-folder");
    setError(null);
    setNotice(null);
    try {
      // Create inside the folder currently open in the browser.
      await mobileFolderMutations(
        wsRef.current!,
        device,
        session,
        encryptionPublicKeyBytes(encryption),
      ).create(name, currentFolderId);
      setFolderNameInput("");
      await loadFolders();
      setNotice("Folder created.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, encryption, session, folderNameInput, currentFolderId, loadFolders]);

  const renameFolder = React.useCallback(
    async (folder: RelayFolder) => {
      const name = folderNameInput.trim();
      if (!device || !encryption || !name) return;
      setBusy(`renaming-${folder.folder_id}`);
      setError(null);
      setNotice(null);
      try {
        await mobileFolderMutations(
          wsRef.current!,
          device,
          session,
          encryptionPublicKeyBytes(encryption),
        ).rename(folder.folder_id, folder.parent_folder_id, name);
        setFolderNameInput("");
        await loadFolders();
        setNotice("Folder renamed.");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [device, encryption, session, folderNameInput, loadFolders],
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
              if (!device || !encryption) return;
              setBusy(`deleting-${folder.folder_id}`);
              setError(null);
              setNotice(null);
              try {
                await mobileFolderMutations(
                  wsRef.current!,
                  device,
                  session,
                  encryptionPublicKeyBytes(encryption),
                ).remove(folder.folder_id);
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
    [device, encryption, session, loadFolders],
  );

  // Download the newest version, decrypt, and hand to the share sheet.
  const downloadOne = React.useCallback(
    async (file: RelayFile) => {
      if (!device) return;
      // Download the version the user chose to keep when resolving a conflict,
      // if one was recorded; otherwise the newest (ADR-0003 addendum).
      const preferredVersion = toCatalogEntry(file).latest_version_number;
      const latest =
        file.versions.find((v) => v.version_number === preferredVersion) ??
        [...file.versions].sort((a, b) => b.version_number - a.version_number)[0];
      if (!latest) {
        setError("file has no versions");
        return;
      }
      setBusy(`downloading-${file.file_id}`);
      setError(null);
      setNotice(null);
      setDownloadStatus("decrypting…");
      setDownloadProgress(null);
      setDownloadTransport(null);
      // Best-effort display name; the decrypted name replaces it once fetched.
      const displayName = fileNames[file.file_id] ?? "file";
      // Captured locally as well as in state: the activity entry is written from
      // this closure, where a state read could still be stale.
      let transport: DownloadTransport | null = null;
      const controller = new AbortController();
      downloadAbortRef.current = controller;
      try {
        const result = await downloadFile({
          fileId: file.file_id,
          versionNumber: latest.version_number,
          shardCount: latest.shard_count,
          encryptedName: file.encrypted_name,
          expectedVersionHash: latest.version_hash,
          deps: mobileDownloadDeps(
            device,
            (value) => {
              transport = value;
              setDownloadTransport(value);
            },
            // Preferred path: pull the shard over WebRTC once the manager has
            // hydrated; until then (or if it throws) the deps fall back to HTTP.
            transferManager?.downloadShardViaWebRtc,
          ),
          // Surface fetch/verify/decrypt stages so Activity can render progress.
          // `startedAt` is stamped on the first event only, so the average
          // throughput is measured from the transfer start rather than reset
          // by every progress report.
          onProgress: (event) =>
            setDownloadProgress((previous) => ({
              fileName: displayName,
              startedAt: previous?.startedAt ?? Date.now(),
              ...event,
            })),
          signal: controller.signal,
        });
        const name = result.name ?? `${file.file_id}.bin`;
        setDownloadStatus(`saving ${name}…`);
        await saveAndShare(result.data, name);
        setDownloadStatus(`downloaded ${name} (${result.data.length} bytes)`);
        setNotice("Download complete.");
        await logActivity({
          kind: "download",
          fileId: file.file_id,
          fileName: name,
          detail: `${result.data.length} bytes`,
          path: transport ? downloadTransportPath(transport) : null,
          outcome: "complete",
        });
      } catch (err) {
        setDownloadStatus(null);
        // A user cancel is expected, not an error: surface a notice and log it
        // as cancelled rather than raising the destructive error line.
        if (err instanceof DownloadCancelledError || controller.signal.aborted) {
          setNotice("Download cancelled.");
          await logActivity({
            kind: "download",
            fileId: file.file_id,
            fileName: fileNames[file.file_id] ?? null,
            detail: "Cancelled",
            path: transport ? downloadTransportPath(transport) : null,
            outcome: "failed",
          });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          await logActivity({
            kind: "download",
            fileId: file.file_id,
            fileName: fileNames[file.file_id] ?? null,
            detail: message,
            path: transport ? downloadTransportPath(transport) : null,
            outcome: "failed",
          });
        }
      } finally {
        // Only clear the ref if this download still owns it (a cancel for a
        // newer download must not be nulled out by the previous one finishing).
        if (downloadAbortRef.current === controller) downloadAbortRef.current = null;
        setDownloadProgress(null);
        setBusy(null);
      }
    },
    [device, fileNames, logActivity, transferManager],
  );

  /** Cancel the active download; the transfer loop rejects and unwinds. */
  const cancelDownload = React.useCallback(() => {
    downloadAbortRef.current?.abort();
  }, []);

  // Best-effort image preview (list/grid thumbnails). Deliberately silent:
  // unlike downloadOne it never sets busy/error or logs activity, because a
  // failed thumbnail is cosmetic and may simply be too large or unreachable.
  const previewImage = React.useCallback(
    async (file: RelayFile, name: string) => {
      if (!device) return null;
      return loadImagePreview(device, file, name);
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
        await logActivity({
          kind: "rename",
          fileId: file.file_id,
          fileName: name,
          detail: `renamed from ${fileNames[file.file_id] ?? "unknown"}`,
          outcome: "complete",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        await logActivity({
          kind: "rename",
          fileId: file.file_id,
          fileName: name,
          detail: message,
          outcome: "failed",
        });
      } finally {
        setBusy(null);
      }
    },
    [device, fileNameInput, loadFiles, fileNames, logActivity],
  );

  const moveFileTo = React.useCallback(
    async (file: RelayFile, folderId: string | null) => {
      if (!device) return;
      setBusy(`moving-file-${file.file_id}`);
      setError(null);
      setNotice(null);
      try {
        await mobileFileMutations(wsRef.current!, device).move(file, folderId);
        await loadFiles();
        setNotice("File moved.");
        await logActivity({
          kind: "move",
          fileId: file.file_id,
          fileName: fileNames[file.file_id] ?? null,
          detail: folderId ? `moved to ${folderNames[folderId] ?? "folder"}` : "moved to Root",
          outcome: "complete",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        await logActivity({
          kind: "move",
          fileId: file.file_id,
          fileName: fileNames[file.file_id] ?? null,
          detail: message,
          outcome: "failed",
        });
      } finally {
        setBusy(null);
      }
    },
    [device, loadFiles, fileNames, folderNames, logActivity],
  );

  // Move into the folder currently open in the browser (list context menu).
  const moveFile = React.useCallback(
    (file: RelayFile) => moveFileTo(file, currentFolderId),
    [moveFileTo, currentFolderId],
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
                await logActivity({
                  kind: "delete",
                  fileId: file.file_id,
                  fileName: fileNames[file.file_id] ?? null,
                  outcome: "complete",
                });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                setError(message);
                await logActivity({
                  kind: "delete",
                  fileId: file.file_id,
                  fileName: fileNames[file.file_id] ?? null,
                  detail: message,
                  outcome: "failed",
                });
              } finally {
                setBusy(null);
              }
            })();
          },
        },
      ]);
    },
    [device, loadFiles, fileNames, logActivity],
  );

  /** Bulk soft-delete; the UI confirms once, so no per-file Alert here. */
  const deleteFiles = React.useCallback(
    async (targets: RelayFile[]) => {
      if (!device || targets.length === 0) return;
      setBusy("deleting-files");
      setError(null);
      setNotice(null);
      try {
        const mutations = mobileFileMutations(wsRef.current!, device);
        for (const target of targets) await mutations.remove(target.file_id);
        await loadFiles();
        setNotice(`Deleted ${targets.length} file(s).`);
        await logActivity({
          kind: "delete",
          detail: `${targets.length} selected file(s)`,
          outcome: "complete",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        await logActivity({ kind: "delete", detail: message, outcome: "failed" });
      } finally {
        setBusy(null);
      }
    },
    [device, loadFiles, logActivity],
  );

  /** Bulk move to one folder (null = root). */
  const moveFilesTo = React.useCallback(
    async (targets: RelayFile[], folderId: string | null) => {
      if (!device || targets.length === 0) return;
      setBusy("moving-files");
      setError(null);
      setNotice(null);
      try {
        const mutations = mobileFileMutations(wsRef.current!, device);
        for (const target of targets) await mutations.move(target, folderId);
        await loadFiles();
        setNotice(`Moved ${targets.length} file(s).`);
        await logActivity({
          kind: "move",
          detail: folderId
            ? `moved ${targets.length} to ${folderNames[folderId] ?? "folder"}`
            : `moved ${targets.length} to Root`,
          outcome: "complete",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        await logActivity({ kind: "move", detail: message, outcome: "failed" });
      } finally {
        setBusy(null);
      }
    },
    [device, loadFiles, folderNames, logActivity],
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
        await logActivity({
          kind: "restore",
          fileId: item.entity_id,
          fileName: tombstoneNames[item.entity_id] ?? null,
          detail: item.entity_type,
          outcome: "complete",
        });
        await loadTombstones();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        await logActivity({
          kind: "restore",
          fileId: item.entity_id,
          fileName: tombstoneNames[item.entity_id] ?? null,
          detail: message,
          outcome: "failed",
        });
      } finally {
        setBusy(null);
      }
    },
    [loadTombstones, tombstoneNames, logActivity],
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
                  await logActivity({
                    kind: "purge",
                    fileId: item.entity_id,
                    fileName: tombstoneNames[item.entity_id] ?? null,
                    detail: item.entity_type,
                    outcome: "complete",
                  });
                  await loadTombstones();
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  setError(message);
                  await logActivity({
                    kind: "purge",
                    fileId: item.entity_id,
                    fileName: tombstoneNames[item.entity_id] ?? null,
                    detail: message,
                    outcome: "failed",
                  });
                } finally {
                  setBusy(null);
                }
              })();
            },
          },
        ],
      );
    },
    [loadTombstones, tombstoneNames, logActivity],
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
      await client.authenticate(device.device_id, (message) =>
        signDeviceMessage(identityPrivateKey(device), message),
      );
      setNotice("Authenticated — the node accepted this device's signature.");
    } catch (err) {
      setError(err instanceof NodeClientError ? `auth failed: ${err.message}` : String(err));
    } finally {
      setBusy(null);
    }
  }, [device, probe]);

  // Re-establish this device's local trust with a storage node. Mirrors the web
  // `ensureNodeTrusted` flow: probe the host we previously paired with, confirm
  // the node advertises the expected id, mint a Relay pairing token, redeem it
  // locally, and refresh the trusted cache. Used after a node data-dir reset,
  // where the node forgot this device but the local trusted-node entry survived
  // and direct WebRTC would otherwise be rejected forever.
  const pairNode = React.useCallback(
    async (nodeId: string) => {
      if (!device || !authed) return;
      setBusy(`pairing-node-${nodeId}`);
      setError(null);
      setNotice(null);
      try {
        await relayRegisterDevice(device, encryption?.public_key);
        const known = (await getTrustedNodes()).find((t) => t.node_id === nodeId);
        if (!known) {
          setError("No saved host for this node — use Pair a device to scan for it.");
          return;
        }
        const base = nodusBaseUrl(known.host);
        const adv = await fetchAdvertisement(base, 2_000);
        if (adv.node_id !== nodeId) {
          setError("That host now advertises a different node; scan to pair the new one.");
          return;
        }
        const session = await relayCreatePairingSession(nodeId, device.device_id);
        const confirm = (await new NodeClient(base).pair(
          session.token,
          nodeId,
          device.device_id,
          identityPublicKey(device),
          5_000,
        )) as { node_id?: string; account_id?: string };
        await addTrustedNode({
          node_id: confirm.node_id ?? nodeId,
          host: known.host,
          account_id: confirm.account_id ?? "re-pair",
          device_id: device.device_id,
          paired_at: new Date().toISOString(),
        });
        setTrusted(await getTrustedNodes());
        setNotice("Re-paired — this device is now trusted by the node.");
      } catch (err) {
        setError(err instanceof NodeClientError ? `pair failed: ${err.message}` : String(err));
      } finally {
        setBusy(null);
      }
    },
    [device, authed, encryption],
  );

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

  // Presentational projections are computed here so screens render from a
  // single source of truth (see the folder browser / upload target).
  return {
    // identity + auth
    device,
    encryption,
    email,
    setEmail,
    password,
    setPassword,
    session,
    authed,
    wsState,
    signIn,
    signOut,
    recoverAccount,
    recoveryPhraseInput,
    setRecoveryPhraseInput,
    signupPhrase,
    beginSignUp,
    cancelSignUp,
    signUp,
    changePassword,
    logoutAll,
    // nodes + pairing
    nodes,
    selectedNode,
    setSelectedNode,
    loadNodes,
    pingNode,
    renaming,
    renameValue,
    setRenameValue,
    beginRename,
    cancelRename,
    submitRename,
    code,
    codeStatus,
    createCode,
    pending,
    issueToken,
    pairingUrl,
    // discovery + local pairing
    candidates,
    host,
    setHost,
    probe,
    scan,
    probeManual,
    selectCandidate,
    pairOnDevice,
    authenticateOnDevice,
    pairNode,
    trusted,
    unpairTrustedNode,
    // upload + download
    uploadPicked,
    uploadStatus,
    uploadProgress,
    lastPath,
    loadFiles,
    files,
    fileNames,
    visibleFiles,
    downloadOne,
    previewImage,
    renameFile,
    moveFile,
    moveFileToFolder: moveFileTo,
    moveFilesTo,
    deleteFile,
    deleteFiles,
    fileNameInput,
    setFileNameInput,
    downloadStatus,
    downloadProgress,
    downloadTransport,
    cancelDownload,
    // folders
    loadFolders,
    folders,
    folderNames,
    folderLabel,
    visibleFolders,
    folderTrail,
    currentFolderId,
    setCurrentFolderId,
    folderNameInput,
    setFolderNameInput,
    createFolder,
    renameFolder,
    deleteFolder,
    // tombstones
    tombstones,
    tombstoneNames,
    loadTombstones,
    restoreTombstone,
    purgeTombstone,
    // devices
    devices,
    loadDevices,
    pingDevice,
    revokeDevice,
    // conflicts
    conflicts,
    loadConflicts,
    resolveConflict,
    // activity log (device-local)
    activity,
    loadActivity,
    clearActivity,
    pendingTransfers,
    // security
    envelopeSummary,
    loadEnvelopes,
    exportEnvelopes,
    securityStatus,
    revealedPhrase,
    setRevealedPhrase,
    revealPhrase,
    copyPhrase,
    rotateRecovery,
    // settings
    shardSizeBytes,
    chooseShardSize,
    notificationPrefs,
    setNotificationPref,
    // transient status
    error,
    notice,
    busy,
  };
}
