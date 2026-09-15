// Trusted Storage Nodes this device has paired with locally (Phase 11).
//
// Stored in SQLite rather than the keychain: a node list is not a secret and
// grows unbounded, whereas expo-secure-store is meant for small credentials.
// The list is the source for Path A host lookup and the "trusted nodes" UI.

import { getDb } from "./db";

/** A storage node this device has established local trust with. */
export interface TrustedNode {
  node_id: string;
  /** Last-known LAN host (IP/hostname) — probes should fall back to a scan. */
  host: string;
  /** Account id on the relay; "local_push" for the offline fast-path. */
  account_id: string;
  device_id: string;
  paired_at: string;
}

export async function getTrustedNodes(): Promise<TrustedNode[]> {
  const db = await getDb();
  return db.getAllAsync<TrustedNode>(
    "SELECT node_id, host, account_id, device_id, paired_at FROM trusted_nodes ORDER BY paired_at ASC",
  );
}

/** Upsert by node_id — one backup host per node wins. */
export async function addTrustedNode(node: TrustedNode): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO trusted_nodes (node_id, host, account_id, device_id, paired_at)
     VALUES (?, ?, ?, ?, ?)`,
    node.node_id,
    node.host,
    node.account_id,
    node.device_id,
    node.paired_at,
  );
}
