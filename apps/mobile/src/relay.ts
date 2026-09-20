/**
 * Thin Relay HTTP client for the mobile app.
 *
 * All credential handling now lives in the @repo/sdk native adapter
 * (`src/adapters.ts`): it attaches the opaque bearer session and captures the
 * session ID the Relay returns to `X-Nodus-Client: mobile` on login/register.
 * These helpers are the typed, app-facing calls on top of that boundary.
 */

import { createAuthClient, type RecipientKind, type SessionInfo } from "@repo/sdk";
import { ActivityListSchema, type ActivityRecord } from "@repo/protocol";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { RELAY_BASE, createNativeRelayHttp, getSessionToken } from "./adapters";
import { detectDeviceInfo } from "./device-info";

export { RELAY_BASE, getSessionToken } from "./adapters";

const http = createNativeRelayHttp();
const auth = createAuthClient(http);

/** Node shape returned by `GET /nodes`. */
export interface RelayNode {
  node_id: string;
  account_id: string;
  public_key: string;
  capabilities: string[];
  status: string;
  is_primary: boolean;
  display_name?: string | null;
  last_seen_at?: string | null;
  used_bytes?: number;
  total_bytes?: number;
  created_at: string;
}

/** Session shape returned by `POST /pairing/sessions` (Phase 11 local trust). */
export interface PairingSession {
  token: string;
  expires_at: string;
  node_id?: string;
  device_id?: string;
}

/** One-time bootstrap code from `POST /pairing/codes` (§7b). */
export interface PairingCode {
  code: string;
  expires_at: string;
}

/** One file version as returned by `GET /files`. */
export interface RelayFileVersion {
  version_number: number;
  shard_count: number;
  version_hash: string;
  conflict_status: string;
  conflicted_name: string | null;
  created_at: string;
}

/** A physical shard location row from `GET /files` (file_locations). */
export interface RelayFileLocation {
  version_number: number;
  shard_index: number;
  node_id: string;
  status: string;
  hash: string | null;
  size_bytes: number | null;
}

/** One file with its versions and shard locations as returned by `GET /files`. */
export interface RelayFile {
  file_id: string;
  parent_folder_id: string | null;
  encrypted_name: string | null;
  created_at: string;
  updated_at: string;
  /** ADR-0003 addendum: version chosen at conflict resolution, if any. */
  preferred_version?: number | null;
  versions: RelayFileVersion[];
  locations: RelayFileLocation[];
}

/** A file-key envelope as returned by `GET /envelopes?file_id=`. */
export interface RelayEnvelope {
  file_id: string;
  recipient_id: string;
  recipient_kind: RecipientKind;
  encrypted_key: string;
}

/** A folder as returned by `GET /folders`. */
export interface RelayFolder {
  folder_id: string;
  parent_folder_id: string | null;
  encrypted_name: string | null;
  created_at: string;
  updated_at: string;
}

/** A folder-key envelope as returned by `GET /folder-envelopes`. */
export interface RelayFolderEnvelope {
  folder_id: string;
  recipient_id: string;
  recipient_kind: RecipientKind;
  encrypted_key: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await http.request<T>(path);
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}${res.error ? `: ${res.error}` : ""}`);
  return res.json as T;
}

/** Account-wide activity feed from the Relay (`GET /activities`). */
export async function relayActivities(limit = 200): Promise<ActivityRecord[]> {
  const body = await getJson<unknown>(`/activities?limit=${limit}`);
  return ActivityListSchema.parse(body).activities;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await http.request<T>(path, { method: "POST", body });
  if (!res.ok) throw new Error(`POST ${path} failed: HTTP ${res.status}${res.error ? `: ${res.error}` : ""}`);
  return res.json as T;
}

/**
 * Sign in and return the persisted session token. The native adapter has
 * already stored the token under the secure-store session key, so callers only
 * need it as an "authenticated" signal.
 */
export async function relayLogin(
  email: string,
  password: string,
  device: StoredDeviceIdentity,
  /** Published X25519 encryption key (ADR-0008); optional. */
  encryptionPublicKey?: string,
): Promise<string> {
  // Attach the native platform fingerprint so the Relay can label this device.
  const result = await auth.login(email, password, { ...device, info: detectDeviceInfo() }, encryptionPublicKey);
  if (!result.ok) throw new Error(result.error ?? "sign-in failed");
  const token = await getSessionToken();
  if (!token) throw new Error("sign-in succeeded but the Relay issued no session");
  return token;
}

export async function relaySession(): Promise<SessionInfo | null> {
  return auth.fetchSession();
}

/**
 * Create an account and return the freshly minted session. The native adapter
 * captures the bearer token from `/auth/register`, exactly as it does for
 * login, so the caller only needs the returned session. `recoveryPublicKey`
 * enrolls the ADR-0002 recovery identity at account-creation time.
 */
export async function relayRegister(
  email: string,
  password: string,
  device: StoredDeviceIdentity,
  recoveryPublicKey?: string,
  encryptionPublicKey?: string,
): Promise<SessionInfo> {
  const result = await auth.register(
    email,
    password,
    { ...device, info: detectDeviceInfo() },
    recoveryPublicKey,
    encryptionPublicKey,
  );
  if (!result.ok || !result.session) {
    throw new Error(result.error ?? "account creation failed");
  }
  return result.session;
}

/**
 * Change the account password. The Relay re-verifies the current password,
 * replaces the hash and rotates the session; the native adapter captures the
 * fresh token, so the returned session supersedes the previous one.
 */
export async function relayChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<SessionInfo> {
  const result = await auth.changePassword(currentPassword, newPassword);
  if (!result.ok || !result.session) throw new Error(result.error ?? "password change failed");
  return result.session;
}

/**
 * Revoke every other session for the account, keeping (and rotating) this
 * device's own session so the caller stays signed in.
 */
export async function relayLogoutAll(): Promise<SessionInfo> {
  const result = await auth.logoutAll();
  if (!result.ok || !result.session) throw new Error(result.error ?? "sign out all failed");
  return result.session;
}

export async function relayLogout(): Promise<void> {
  await auth.logout();
}

/** Register (or refresh) this device's Expo push token and category prefs. */
export async function relayRegisterPushToken(
  token: string,
  platform: string,
  prefs: { conflicts: boolean; deviceOffline: boolean; syncComplete: boolean },
): Promise<void> {
  const res = await http.request("/devices/push-token", {
    method: "POST",
    body: {
      token,
      platform,
      // The relay mirrors these so it can honour opt-outs at fan-out time.
      prefs: {
        conflicts: prefs.conflicts,
        device_offline: prefs.deviceOffline,
        sync_complete: prefs.syncComplete,
      },
    },
  });
  if (!res.ok) throw new Error(res.error ?? `push token registration failed: HTTP ${res.status}`);
}

/** Remove this device's push token (called on sign-out). */
export async function relayDeletePushToken(): Promise<void> {
  const res = await http.request("/devices/push-token", { method: "DELETE" });
  if (!res.ok) throw new Error(res.error ?? `push token removal failed: HTTP ${res.status}`);
}

export async function relayNodes(): Promise<RelayNode[]> {
  return getJson<RelayNode[]>("/nodes");
}

/** Manual reachability probe for a storage node over its WS connection. */
export async function relayPingNode(nodeId: string): Promise<void> {
  const res = await http.request(`/nodes/${encodeURIComponent(nodeId)}/ping`, { method: "POST" });
  if (!res.ok) throw new Error(res.error ?? `ping failed: HTTP ${res.status}`);
}

/** Assign (or clear, with "") a node's display name. */
export async function relayRenameNode(nodeId: string, name: string): Promise<string | null> {
  const res = await http.request<{ display_name?: string | null }>(
    `/nodes/${encodeURIComponent(nodeId)}`,
    { method: "PATCH", body: { name } },
  );
  if (!res.ok) throw new Error(res.error ?? `rename failed: HTTP ${res.status}`);
  return res.json?.display_name ?? null;
}

/** Device shape returned by `GET /devices` (used for envelope recipients). */
export interface RelayDevice {
  device_id: string;
  account_id: string;
  public_key: string;
  status: string;
  display_name?: string | null;
  created_at: string;
  revoked_at?: string | null;
  last_seen_at?: string | null;
  /** Auto-captured platform/browser metadata; absent for older clients. */
  device_info?: {
    platform?: string;
    os_version?: string;
    browser?: string;
    app_version?: string;
    user_agent?: string;
  } | null;
}

export async function relayDevices(): Promise<RelayDevice[]> {
  return getJson<RelayDevice[]>("/devices");
}

/** Revoke a device (also kills its sessions); required by ADR-0001. */
export async function relayRevokeDevice(deviceId: string): Promise<void> {
  const res = await http.request(`/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(res.error ?? `revoke failed: HTTP ${res.status}`);
}

/** Assign (or clear, with "") a device's display name. */
export async function relayRenameDevice(deviceId: string, name: string): Promise<string | null> {
  const res = await http.request<{ display_name?: string | null }>(
    `/devices/${encodeURIComponent(deviceId)}`,
    { method: "PATCH", body: { name } },
  );
  if (!res.ok) throw new Error(res.error ?? `rename failed: HTTP ${res.status}`);
  return res.json?.display_name ?? null;
}

/** Manual reachability probe (Relay sends a ping over the device's WS). */
export async function relayPingDevice(deviceId: string): Promise<void> {
  const res = await http.request(`/devices/${encodeURIComponent(deviceId)}/ping`, { method: "POST" });
  if (!res.ok) throw new Error(res.error ?? `ping failed: HTTP ${res.status}`);
}

/** Idempotent upsert so CreatePairingSession can find the device's key. */
export async function relayRegisterDevice(
  device: StoredDeviceIdentity,
  /** Published X25519 encryption key (ADR-0008); optional. */
  encryptionPublicKey?: string,
): Promise<void> {
  await post("/devices/register", {
    device_id: device.device_id,
    public_key: device.public_key,
    encryption_public_key: encryptionPublicKey,
    device_info: detectDeviceInfo(),
  });
}

export async function relayCreatePairingSession(nodeId: string, deviceId: string): Promise<PairingSession> {
  return post<PairingSession>("/pairing/sessions", { node_id: nodeId, device_id: deviceId });
}

/** Mint a one-time §7b bootstrap code; the plaintext is returned only here. */
export async function relayCreatePairingCode(): Promise<PairingCode> {
  return post<PairingCode>("/pairing/codes");
}

/** Catalog with per-version `conflict_status` (ADR-0003 inbox source). */
export async function relayFiles(): Promise<RelayFile[]> {
  return getJson<RelayFile[]>("/files");
}

/**
 * Resolve a file's conflicted copy over HTTP. Mobile has no browser session
 * cookie for the WebSocket event path, so the Relay exposes this REST endpoint;
 * it marks the file's flagged versions resolved and notifies connected nodes.
 *
 * `keepVersion` (ADR-0003 addendum) records which side to keep as the file's
 * current version; omitting it keeps the pre-existing "newest wins" behavior.
 */
export async function relayResolveConflict(
  fileId: string,
  keepVersion?: number,
): Promise<{ status: string; resolved: number; preferred_version?: number }> {
  return post(
    `/files/${encodeURIComponent(fileId)}/conflicts/resolve`,
    keepVersion === undefined ? undefined : { keep_version: keepVersion },
  );
}

/** Per-node soft-delete/purge progress for one tombstone. */
export interface TombstoneNodeStatus {
  node_id: string;
  deleted_at: string | null;
  purged_at: string | null;
}

export type TombstoneEntityType = "file" | "folder";

/** A soft-deleted item as returned by `GET /tombstones`. */
export interface RelayTombstone {
  entity_type: TombstoneEntityType;
  entity_id: string;
  encrypted_name: string | null;
  deleted_at: string;
  purge_after: string;
  purge_requested_at: string | null;
  nodes: TombstoneNodeStatus[];
}

export async function relayTombstones(): Promise<RelayTombstone[]> {
  return getJson<RelayTombstone[]>("/tombstones");
}

/** Permanently delete a tombstoned item (asks every node to purge it). */
export async function relayPurgeTombstone(
  entityType: TombstoneEntityType,
  entityId: string,
): Promise<void> {
  const res = await http.request(
    `/tombstones/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(res.error ?? `purge failed: HTTP ${res.status}`);
}

/** Restore a soft-deleted item across nodes. */
export async function relayRestoreTombstone(
  entityType: TombstoneEntityType,
  entityId: string,
): Promise<void> {
  const res = await http.request(
    `/tombstones/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/restore`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(res.error ?? `restore failed: HTTP ${res.status}`);
}

export async function relayEnvelopes(fileId: string): Promise<RelayEnvelope[]> {
  return getJson<RelayEnvelope[]>(`/envelopes?file_id=${encodeURIComponent(fileId)}`);
}

export async function relayFolders(): Promise<RelayFolder[]> {
  return getJson<RelayFolder[]>("/folders");
}

/** Per-recipient key-envelope coverage (Security screen). */
export interface EnvelopeSummary {
  recipient_id: string;
  recipient_kind: string;
  file_count: number;
  folder_count: number;
  last_updated: string | null;
}

export async function relayEnvelopeSummary(): Promise<EnvelopeSummary[]> {
  return getJson<EnvelopeSummary[]>("/envelopes/summary");
}

/** Ciphertext-only backup of every envelope, as a JSON string for sharing. */
export async function relayEnvelopeExport(): Promise<unknown> {
  return getJson<unknown>("/envelopes/export");
}

/** Bulk folder-key envelopes: one request opens every folder name. */
export async function relayFolderEnvelopes(): Promise<RelayFolderEnvelope[]> {
  return getJson<RelayFolderEnvelope[]>("/folder-envelopes");
}

/**
 * Fetch a stored shard's raw ciphertext through the Relay (design A fallback).
 * The Relay resolves the account from the bearer session and pulls the object
 * from whichever node holds it; the SDK adapter's JSON path cannot return raw
 * bytes, so this reads the response body directly.
 */
export async function fetchRelayShard(
  hash: string,
  onProgress?: (receivedBytes: number, totalBytes: number) => void,
): Promise<Uint8Array> {
  const token = await getSessionToken();
  const res = await fetch(`${RELAY_BASE}/shards/${encodeURIComponent(hash)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`relay shard fetch failed: HTTP ${res.status}`);
  }
  // React Native's fetch may not expose a body reader; when it does, stream for
  // mid-shard progress, otherwise fall back to a buffered read.
  const reader = res.body?.getReader?.();
  if (!reader) {
    return new Uint8Array(await res.arrayBuffer());
  }
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        try {
          onProgress?.(received, total);
        } catch {
          // Advisory only: a throwing subscriber must not abort the read.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
