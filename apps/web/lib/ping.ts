// Manual reachability probes for the Devices page.
//
// Preferred path: the Relay WebSocket. The bridge the WsProvider installs lets
// the Relay forward a `ping` to the target's socket and report the real round
// trip back as a `presence_result`; issuing it on the device's existing socket
// removes the HTTP hop the old `/api/{nodes,devices}/ping` BFF proxies needed.
// The HTTP endpoints remain as a fallback when the socket is not connected.

import { MessageTypes } from "@repo/protocol";

import { getPresenceBridge, type PresenceBridge } from "./presence-bridge";

export interface PingResult {
  online: boolean;
  /** Round-trip time in milliseconds; present only when `online`. */
  rttMs?: number;
  /** Why the probe failed: "offline" (no live connection) or "timeout". */
  reason?: string;
}

interface PingResponseBody {
  online: boolean;
  rtt_ms?: number;
  reason?: string;
}

interface PresenceResultPayload {
  request_id?: unknown;
  online?: unknown;
  rtt_ms?: unknown;
  reason?: unknown;
}

/** Allow a little more than the Relay's own 3 s ping budget before falling back. */
const PRESENCE_TIMEOUT_MS = 4_000;

/**
 * Probe over the Relay socket. Resolves `null` when no `presence_result` arrives
 * in time, which the caller treats as "try HTTP" rather than "offline" — an
 * unanswered socket probe should not be reported as unreachable.
 */
function pingViaSocket(
  bridge: PresenceBridge,
  peerId: string,
  kind: "node" | "device",
): Promise<PingResult | null> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    const finish = (result: PingResult | null) => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve(result);
    };
    const off = bridge.subscribe(MessageTypes.PRESENCE_RESULT, (payload) => {
      const body = payload as PresenceResultPayload;
      if (!body || body.request_id !== requestId) return;
      finish({
        online: Boolean(body.online),
        rttMs: typeof body.rtt_ms === "number" ? body.rtt_ms : undefined,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
    });
    const timer = setTimeout(() => finish(null), PRESENCE_TIMEOUT_MS);
    bridge.send({
      type: MessageTypes.PRESENCE_QUERY,
      payload: { request_id: requestId, peer_id: peerId, kind },
    });
  });
}

async function postPing(path: string): Promise<PingResult> {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `ping failed: ${res.status}`);
  }
  const body = (await res.json()) as PingResponseBody;
  return { online: body.online, rttMs: body.rtt_ms, reason: body.reason };
}

async function ping(peerId: string, kind: "node" | "device"): Promise<PingResult> {
  const bridge = getPresenceBridge();
  if (bridge?.isConnected()) {
    const viaSocket = await pingViaSocket(bridge, peerId, kind);
    if (viaSocket) return viaSocket;
  }
  const path =
    kind === "node"
      ? `/api/nodes/${encodeURIComponent(peerId)}/ping`
      : `/api/devices/${encodeURIComponent(peerId)}/ping`;
  return postPing(path);
}

export function pingNode(nodeId: string): Promise<PingResult> {
  return ping(nodeId, "node");
}

export function pingDevice(deviceId: string): Promise<PingResult> {
  return ping(deviceId, "device");
}
