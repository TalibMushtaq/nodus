import {
  NodeClient,
  fetchAdvertisement,
  identityPublicKey,
  nodusBaseUrl,
} from "@repo/relay-client";

import { getOrCreateDevice } from "./device";
import { issuePairingToken } from "./pairing";
import { addTrustedNode, getTrustedNodes } from "./trusted-nodes";

/**
 * Which LAN hosts this browser will probe when auto-pairing. Deliberately
 * restricted to loopback plus the host serving the page — the browser must
 * never port-scan the network looking for nodes. Probed in order; the node
 * must advertise the exact `node_id` of the node being paired for a probe to
 * count as a match.
 */
export function autoPairCandidateHosts(
  locationHost: string = globalThis.location?.hostname ?? "",
): string[] {
  const candidates: string[] = [];
  const push = (host: string) => {
    const trimmed = host?.trim().toLowerCase();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };
  push("127.0.0.1");
  push(locationHost);
  return candidates;
}

export interface EnsureNodeTrustedResult {
  paired: boolean;
  host?: string;
}

/**
 * Ensure this browser trusts the given storage node, silently pairing with it
 * over its local listener when possible (design B: auto-pair on upload).
 *
 * Requirements for a silent pair:
 *   - the node must be reachable at a candidate host on the local port, and
 *   - its discovery advertisement must confirm it owns the given `node_id`.
 *
 * The flow mirrors the manual "Pair on this device" path but with zero dialogs:
 * probe → issue a Relay pairing token bound to this device → redeem it against
 * the node → record the node in trusted-nodes. Failures are swallowed: this is
 * best-effort, the Relay-mediated download fallback covers the paired-elsewhere
 * and node-offline cases regardless.
 */
export async function ensureNodeTrusted(nodeId: string): Promise<EnsureNodeTrustedResult> {
  if (typeof window === "undefined" || !nodeId) return { paired: false };

  const trusted = await getTrustedNodes();
  if (trusted.some((t) => t.node_id === nodeId)) return { paired: true };

  const { identity: device } = await getOrCreateDevice();

  for (const host of autoPairCandidateHosts()) {
    const base = nodusBaseUrl(host);
    try {
      const adv = await fetchAdvertisement(base, 2_000);
      if (adv.node_id !== nodeId) continue;
      const session = await issuePairingToken(nodeId, device);
      const client = new NodeClient(base);
      const confirm = await client.pair(
        session.token,
        nodeId,
        device.device_id,
        identityPublicKey(device),
        5_000,
      );
      await addTrustedNode({
        node_id: (confirm?.node_id as string | undefined) ?? nodeId,
        host,
        account_id: (confirm?.account_id as string | undefined) ?? "auto-pair",
        device_id: device.device_id,
        paired_at: new Date().toISOString(),
      });
      return { paired: true, host };
    } catch {
      // Unreachable, mismatched node, or pair rejected — try the next host.
    }
  }
  return { paired: false };
}