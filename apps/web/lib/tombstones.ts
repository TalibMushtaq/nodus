// Tombstone (soft-delete) client. Backed by the Relay's /tombstones endpoints:
// list soft-deleted files/folders, permanently purge them, or restore them.
//
// An item is "live" in the Tombstone list while its tombstone exists; permanent
// delete and the 90-day retention window remove it. Per-node ack rows show how
// far each storage node has progressed (deleted vs purged).

export type TombstoneEntityType = "file" | "folder";

export interface TombstoneNodeStatus {
  node_id: string;
  /** ISO timestamp the node applied the tombstone, or null if it hasn't. */
  deleted_at: string | null;
  /** ISO timestamp the node purged the data, or null. */
  purged_at: string | null;
}

export interface TombstoneItem {
  entity_type: TombstoneEntityType;
  entity_id: string;
  /** FEK-encrypted name; the client decrypts it. */
  encrypted_name: string | null;
  deleted_at: string;
  /** When the retention pruner will permanently remove the item. */
  purge_after: string;
  /** Set once permanent delete is requested; nodes are then purging. */
  purge_requested_at: string | null;
  nodes: TombstoneNodeStatus[];
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${fallback}: ${res.status}`;
}

export async function listTombstones(): Promise<TombstoneItem[]> {
  const res = await fetch("/api/tombstones");
  if (!res.ok) {
    throw new Error(await readError(res, "failed to load tombstones"));
  }
  return (await res.json()) as TombstoneItem[];
}

/** Permanently delete one tombstoned entity (Relay + owning nodes). */
export async function purgeTombstone(entityType: TombstoneEntityType, entityId: string): Promise<void> {
  const res = await fetch(
    `/api/tombstones/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(await readError(res, "failed to purge"));
  }
}

/** Undo a soft delete: the entity reappears and its retained data is kept. */
export async function restoreTombstone(entityType: TombstoneEntityType, entityId: string): Promise<void> {
  const res = await fetch(
    `/api/tombstones/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/restore`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(await readError(res, "failed to restore"));
  }
}

/** Human label for an item's delete/purge progress across the Relay and nodes. */
export function tombstoneStatus(item: TombstoneItem): { label: string; tone: "pending" | "synced" | "offline" } {
  const purgedAll = item.nodes.length > 0 && item.nodes.every((n) => n.purged_at);
  if (item.purge_requested_at) {
    if (item.nodes.length === 0 || purgedAll) return { label: "Permanently deleted", tone: "synced" };
    const waiting = item.nodes.filter((n) => !n.purged_at).length;
    return { label: `Purging — waiting for ${waiting} node${waiting === 1 ? "" : "s"}`, tone: "pending" };
  }
  const deletedAll = item.nodes.length === 0 || item.nodes.every((n) => n.deleted_at);
  if (deletedAll) {
    return { label: item.nodes.length === 0 ? "Deleted (Relay)" : "Deleted from Relay and node", tone: "synced" };
  }
  const waiting = item.nodes.filter((n) => !n.deleted_at).length;
  return { label: `Deleted from Relay — waiting for ${waiting} node${waiting === 1 ? "" : "s"}`, tone: "pending" };
}
