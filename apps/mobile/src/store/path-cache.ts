// SQLite-backed PathCache for the mobile Transfer Manager. The manager's
// PathCache interface is synchronous, so this keeps an in-memory mirror and
// hydrates it from SQLite before use (`await hydrate()`); writes go to both so a
// later session remembers which path last worked for a node.

import type { PathCache, PathCacheEntry, TransferPath } from "@repo/transfer-manager";

import { getDb } from "./db";

interface CachedPathRow {
  node_id: string;
  path: TransferPath;
  last_success_at: number;
}

export class SqlitePathCache implements PathCache {
  private memory = new Map<string, PathCacheEntry>();
  private hydrated = false;

  /** Load persisted entries. Call once before the manager starts using it. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const db = await getDb();
    const rows = await db.getAllAsync<CachedPathRow>("SELECT * FROM path_cache");
    for (const row of rows) {
      this.memory.set(row.node_id, { path: row.path, lastSuccessAt: row.last_success_at });
    }
    this.hydrated = true;
  }

  get(nodeId: string): PathCacheEntry | undefined {
    return this.memory.get(nodeId);
  }

  set(nodeId: string, path: TransferPath): void {
    const entry: PathCacheEntry = { path, lastSuccessAt: Date.now() };
    this.memory.set(nodeId, entry);
    // Fire-and-forget: the interface is sync and a missed persist only costs a
    // cold-start cache miss next session, not correctness.
    void (async () => {
      const db = await getDb();
      await db.runAsync(
        "INSERT OR REPLACE INTO path_cache (node_id, path, last_success_at) VALUES (?, ?, ?)",
        nodeId,
        path,
        entry.lastSuccessAt,
      );
    })().catch(() => undefined);
  }

  evict(nodeId: string): void {
    this.memory.delete(nodeId);
    void (async () => {
      const db = await getDb();
      await db.runAsync("DELETE FROM path_cache WHERE node_id = ?", nodeId);
    })().catch(() => undefined);
  }
}
