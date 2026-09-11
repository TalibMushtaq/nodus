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
  last_seen_at?: string | null;
  created_at: string;
}

/** Mirrors the Relay's DeviceResponse (GET /devices) — the *only* client
 * identity the Relay catalogs (no display name / model / OS is stored). */
export interface RelayDevice {
  device_id: string;
  account_id: string;
  public_key: string;
  status: string;
  created_at: string;
  revoked_at?: string | null;
}

/** Mirrors the Relay's pairing-code creation response (POST /pairing/codes). */
export interface PairingCode {
  code: string;
  expires_at: string;
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

/**
 * Registers the browser device against the Relay (idempotent ownership-safe
 * upsert) so a pairing token can be bound to it.
 */
export async function registerDevice(device: StoredDeviceIdentity): Promise<void> {
  const res = await fetch("/api/devices/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: device.device_id, public_key: device.public_key }),
  });
  if (!res.ok) {
    throw new Error(`device registration failed: ${res.status}`);
  }
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