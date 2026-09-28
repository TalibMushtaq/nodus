// Trusted-node cache for the web client, backed by the shared IndexedDB opener
// (lib/db.ts). The LAN pairing flow records which Storage Nodes this browser
// device has successfully paired with, keyed by node_id, so discovery UIs can
// show "known nodes" without re-advertising and re-auth can target a host.

import { STORE_TRUSTED_NODES, idbGetAll, idbPut } from "./db";
import { normalizeLanHost } from "./lan-host";

export interface TrustedNode {
  node_id: string;
  host: string;
  account_id: string;
  device_id: string;
  paired_at: string;
}

/** List all trusted nodes, newest-paired first. */
export async function getTrustedNodes(): Promise<TrustedNode[]> {
  const nodes = await idbGetAll<TrustedNode>(STORE_TRUSTED_NODES);
  // Default a missing/non-string timestamp so a hand-edited or migrated record
  // cannot throw out of a simple list call.
  return nodes.sort((a, b) => (b.paired_at ?? "").localeCompare(a.paired_at ?? ""));
}

/**
 * Record a successful pairing (idempotent by node_id). The host is validated
 * and normalized first: it later feeds `nodusBaseUrl` for signed shard fetches,
 * so a malformed value must never be persisted as a trust anchor.
 */
export async function addTrustedNode(node: TrustedNode): Promise<void> {
  const host = normalizeLanHost(node.host);
  if (!host) {
    throw new Error(`refusing to trust a node with an invalid host: ${node.host}`);
  }
  await idbPut<TrustedNode>(STORE_TRUSTED_NODES, { ...node, host });
}
