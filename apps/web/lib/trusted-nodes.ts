// Trusted-node cache for the web client, backed by the shared IndexedDB opener
// (lib/db.ts). The LAN pairing flow records which Storage Nodes this browser
// device has successfully paired with, keyed by node_id, so discovery UIs can
// show "known nodes" without re-advertising and re-auth can target a host.

import { STORE_TRUSTED_NODES, idbGetAll, idbPut } from "./db";

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
  return nodes.sort((a, b) => b.paired_at.localeCompare(a.paired_at));
}

/** Record a successful pairing (idempotent by node_id). */
export async function addTrustedNode(node: TrustedNode): Promise<void> {
  await idbPut(STORE_TRUSTED_NODES, node);
}
