// Manual reachability probes for the Devices page.
//
// The Relay sends a `ping` over the target's live WebSocket connection and waits
// for its `pong`, so the result is a real round trip (a hung peer with an open
// socket is reported unreachable) rather than a catalog-based guess.

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

async function postPing(path: string): Promise<PingResult> {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `ping failed: ${res.status}`);
  }
  const body = (await res.json()) as PingResponseBody;
  return { online: body.online, rttMs: body.rtt_ms, reason: body.reason };
}

export function pingNode(nodeId: string): Promise<PingResult> {
  return postPing(`/api/nodes/${encodeURIComponent(nodeId)}/ping`);
}

export function pingDevice(deviceId: string): Promise<PingResult> {
  return postPing(`/api/devices/${encodeURIComponent(deviceId)}/ping`);
}
