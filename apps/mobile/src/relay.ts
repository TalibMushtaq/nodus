/**
 * Thin Relay HTTP client for the mobile pairing flow (Relay Path B).
 *
 * The web pairing screen performs these same calls inline; on mobile they are
 * factored out so App.tsx stays about state, not transport. Everything here is
 * plain `fetch` — no WS needed for the Phase 11 pairing flow.
 */

import type { StoredDeviceIdentity } from "@repo/relay-client/device-identity";

export const RELAY_BASE = process.env.EXPO_PUBLIC_RELAY_URL ?? "http://localhost:8080";

/** Node shape returned by `GET /nodes`. */
export interface RelayNode {
  node_id: string;
  account_id: string;
  public_key: string;
  capabilities: string[];
  status: string;
  is_primary: boolean;
  created_at: string;
}

/** Session shape returned by `POST /pairing/sessions`. */
export interface PairingSession {
  token: string;
  expires_at: string;
  node_id?: string;
  device_id?: string;
}

async function json<T>(
  url: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} failed: HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function relayLogin(email: string, password: string): Promise<string> {
  const body = await json<{ access_token: string }>(`${RELAY_BASE}/auth/login`, {
    method: "POST",
    body: { email, password },
  });
  return body.access_token;
}

export async function relayNodes(jwt: string): Promise<RelayNode[]> {
  return json<RelayNode[]>(`${RELAY_BASE}/nodes`, { token: jwt });
}

/** Idempotent upsert so CreatePairingSession can find the device's key. */
export async function relayRegisterDevice(
  jwt: string,
  device: StoredDeviceIdentity,
): Promise<void> {
  await json<Record<string, unknown>>(`${RELAY_BASE}/devices/register`, {
    method: "POST",
    token: jwt,
    body: { device_id: device.device_id, public_key: device.public_key },
  });
}

export async function relayCreatePairingSession(
  jwt: string,
  nodeId: string,
  deviceId: string,
): Promise<PairingSession> {
  return json<PairingSession>(`${RELAY_BASE}/pairing/sessions`, {
    method: "POST",
    token: jwt,
    body: { node_id: nodeId, device_id: deviceId },
  });
}