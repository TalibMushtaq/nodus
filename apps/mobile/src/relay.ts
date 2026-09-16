/**
 * Thin Relay HTTP client for the mobile app.
 *
 * All credential handling now lives in the @repo/sdk native adapter
 * (`src/adapters.ts`): it attaches the opaque bearer session and captures the
 * session ID the Relay returns to `X-Nodus-Client: mobile` on login/register.
 * These helpers are the typed, app-facing calls on top of that boundary.
 */

import { createAuthClient, type RecipientKind, type SessionInfo } from "@repo/sdk";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { RELAY_BASE, createNativeRelayHttp, getSessionToken } from "./adapters";

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
  const result = await auth.login(email, password, device, encryptionPublicKey);
  if (!result.ok) throw new Error(result.error ?? "sign-in failed");
  const token = await getSessionToken();
  if (!token) throw new Error("sign-in succeeded but the Relay issued no session");
  return token;
}

export async function relaySession(): Promise<SessionInfo | null> {
  return auth.fetchSession();
}

export async function relayLogout(): Promise<void> {
  await auth.logout();
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
 */
export async function relayResolveConflict(fileId: string): Promise<{ status: string; resolved: number }> {
  return post(`/files/${encodeURIComponent(fileId)}/conflicts/resolve`);
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
export async function fetchRelayShard(hash: string): Promise<Uint8Array> {
  const token = await getSessionToken();
  const res = await fetch(`${RELAY_BASE}/shards/${encodeURIComponent(hash)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`relay shard fetch failed: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
