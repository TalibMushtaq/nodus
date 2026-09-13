import type { StoredDeviceIdentity } from "@repo/relay-client";

// Client-side gateway to the /pairing proxy route handlers. Authentication is
// the HttpOnly session cookie managed by Next; these helpers only pass JSON
// through and never build an Authorization header.

/** Mirrors the Relay's NodeResponse (GET /nodes). */
export interface RelayNode {
  node_id: string;
  account_id: string;
  public_key: string;
  capabilities: string[];
  status: string;
  is_primary: boolean;
  /** User-assigned label; absent until renamed. */
  display_name?: string | null;
  last_seen_at?: string | null;
  created_at: string;
}

/** Mirrors the Relay's DeviceResponse (GET /devices). The Relay stores no
 * model/OS metadata; `display_name` is the account's own label for the device. */
export interface RelayDevice {
  device_id: string;
  account_id: string;
  public_key: string;
  status: string;
  /** User-assigned label; absent until renamed. */
  display_name?: string | null;
  created_at: string;
  revoked_at?: string | null;
}

/** Mirrors the Relay's pairing-code creation response (POST /pairing/codes). */
export interface PairingCode {
  code: string;
  expires_at: string;
}

/**
 * How long after its last heartbeat a node is still considered online.
 *
 * The Relay stores only `last_seen_at` (a timestamp), so staleness must be
 * derived client-side. Treating the mere presence of `last_seen_at` as "online"
 * (the previous behavior) left nodes permanently green; this window makes an
 * unresponsive node fall back to offline. It is intentionally a few heartbeat
 * intervals wide so a single missed beat does not flap the status.
 */
export const NODE_ONLINE_WINDOW_MS = 2 * 60 * 1000;

/** True when the node heartbeated within `NODE_ONLINE_WINDOW_MS`. */
export function isNodeOnline(node: RelayNode, now: number = Date.now()): boolean {
  if (!node.last_seen_at) return false;
  const seen = new Date(node.last_seen_at).getTime();
  if (Number.isNaN(seen)) return false;
  return now - seen <= NODE_ONLINE_WINDOW_MS;
}

/** Device catalog from GET /api/devices (session-cookie proxy). */
export async function listDevices(): Promise<RelayDevice[]> {
  const res = await fetch("/api/devices");
  if (!res.ok) {
    throw new Error(`failed to load devices: ${res.status}`);
  }
  return (await res.json()) as RelayDevice[];
}

/**
 * Mint a one-time pairing code via POST /api/pairing/codes. The session cookie
 * authenticates the account; the returned plaintext is the only copy (the
 * Relay stores just its SHA-256 hash).
 */
export async function createPairingCode(): Promise<PairingCode> {
  const res = await fetch("/api/pairing/codes", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) {
    // Surface the Relay's machine-readable reason (e.g. rate_limit_exceeded,
    // unauthorized) so callers can render it; fall back to the HTTP status.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `pairing code creation failed: ${res.status}`);
  }
  return (await res.json()) as PairingCode;
}

/** Revoke a device via DELETE /api/devices/{id}, which also kills its sessions. */
export async function revokeDevice(deviceId: string): Promise<void> {
  const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`device revocation failed: ${res.status}`);
  }
}

/**
 * Assign (or clear, with an empty string) a node's display name via
 * PATCH /api/nodes/{node_id}. Returns the stored value: null when cleared.
 */
export async function renameNode(nodeId: string, name: string): Promise<string | null> {
  return patchDisplayName(`/api/nodes/${encodeURIComponent(nodeId)}`, name, "node");
}

/** Assign (or clear) a device's display name via PATCH /api/devices/{id}. */
export async function renameDevice(deviceId: string, name: string): Promise<string | null> {
  return patchDisplayName(`/api/devices/${encodeURIComponent(deviceId)}`, name, "device");
}

async function patchDisplayName(path: string, name: string, kind: "node" | "device"): Promise<string | null> {
  const res = await fetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${kind} rename failed: ${res.status}`);
  }
  const body = (await res.json()) as { display_name?: string | null };
  return body.display_name ?? null;
}

/** Mirrors the Relay's PairingSessionResponse (POST /pairing/sessions). */
export interface PairingSession {
  token: string;
  expires_at: string;
  node_id: string;
  device_id: string;
}

export async function listNodes(): Promise<RelayNode[]> {
  const res = await fetch("/api/nodes");
  if (!res.ok) {
    throw new Error(`failed to load nodes: ${res.status}`);
  }
  return (await res.json()) as RelayNode[];
}

/**
 * Locate a node in a catalog snapshot by `node_id`. The pairing flow polls
 * `listNodes()` and treats `undefined` as "not paired yet" (pending) until the
 * redeemed node appears.
 */
export function findNode(nodes: RelayNode[], nodeId: string): RelayNode | undefined {
  return nodes.find((n) => n.node_id === nodeId);
}

/**
 * First node in `nodes` whose id is not already present in `existingIds`.
 *
 * The browser only mints the pairing code, so it never learns the node's
 * `node_id` ahead of time; success is detected by diffing the catalog against
 * a baseline snapshotted when the dialog opened. Returns `undefined` while the
 * node is still pending (not yet registered).
 */
export function findNewNode(
  existingIds: string[],
  nodes: RelayNode[],
): RelayNode | undefined {
  const known = new Set(existingIds);
  return nodes.find((n) => !known.has(n.node_id));
}

export async function issuePairingToken(nodeId: string, device: StoredDeviceIdentity): Promise<PairingSession> {
  const res = await fetch("/api/pairing/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, device_id: device.device_id }),
  });
  if (!res.ok) {
    throw new Error(`token issuance failed: ${res.status}`);
  }
  return (await res.json()) as PairingSession;
}