import {
  NodeClient,
  fetchAdvertisement,
  identityPublicKey,
  nodusBaseUrl,
} from "@repo/relay-client";

import type { DevicePublicIdentity, DeviceSigner } from "@repo/sdk";

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
 * Whether a Storage Node still recognizes this device. Direct transfers (Path A
 * LAN WebRTC, Path B relay-signaled WebRTC) are gated on the node's `devices`
 * table, so a stale browser-side cache entry is worse than useless: the node
 * rejects every offer as "not a paired device" and the browser never re-pairs.
 * A challenge-response round trip is the authoritative check — the node answers
 * `unknown_device` if it has forgotten this device (e.g. its data dir was
 * reset), which tells the caller to pair again.
 */
async function nodeRecognizesDevice(
  host: string,
  nodeId: string,
  device: DevicePublicIdentity,
  signer: DeviceSigner,
): Promise<boolean> {
  try {
    const base = nodusBaseUrl(host);
    const adv = await fetchAdvertisement(base, 2_000);
    if (adv.node_id !== nodeId) return false;
    await new NodeClient(base).authenticate(device.device_id, (message) => signer.sign(message));
    return true;
  } catch {
    return false;
  }
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
 *
 * A cached trusted-node entry is re-verified first (see `nodeRecognizesDevice`)
 * rather than short-circuiting on it: the node's device table can be lost while
 * this browser's IndexedDB survives, after which direct WebRTC silently fails
 * forever because the early return skipped re-pairing.
 */
export async function ensureNodeTrusted(nodeId: string): Promise<EnsureNodeTrustedResult> {
  if (typeof window === "undefined" || !nodeId) return { paired: false };

  const { identity: device, signer } = await getOrCreateDevice();

  const trusted = await getTrustedNodes();
  const known = trusted.find((t) => t.node_id === nodeId);
  if (known && (await nodeRecognizesDevice(known.host, nodeId, device, signer))) {
    return { paired: true, host: known.host };
  }

  // Try the cached host first — it may differ from the page origin — then the
  // loopback/page-host candidates, deduped so the known host is not probed twice.
  const hosts = [...new Set([...(known ? [known.host] : []), ...autoPairCandidateHosts()])];
  for (const host of hosts) {
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
