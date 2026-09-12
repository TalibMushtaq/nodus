// IndexedDB-backed PathCache for the browser Transfer Manager. The manager's
// PathCache interface is synchronous, so this keeps an in-memory mirror and
// hydrates it from IndexedDB before use (`await hydrate()`); writes go to both
// so a later session remembers which path last worked for a node.

import type { PathCache, PathCacheEntry, TransferPath } from "@repo/transfer-manager";
import { STORE_PATH_CACHE, idbDelete, idbGetAll, idbPut } from "../db";

interface CachedPathRow {
  node_id: string;
  path: TransferPath;
  lastSuccessAt: number;
}

export class IndexedDBPathCache implements PathCache {
  private memory = new Map<string, PathCacheEntry>();
  private hydrated = false;

  /** Load persisted entries. Call once before the manager starts using it. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const rows = await idbGetAll<CachedPathRow>(STORE_PATH_CACHE);
    for (const row of rows) {
      this.memory.set(row.node_id, { path: row.path, lastSuccessAt: row.lastSuccessAt });
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
    void idbPut<CachedPathRow>(STORE_PATH_CACHE, { node_id: nodeId, ...entry });
  }

  evict(nodeId: string): void {
    this.memory.delete(nodeId);
    void idbDelete(STORE_PATH_CACHE, nodeId);
  }
}
