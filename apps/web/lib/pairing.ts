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