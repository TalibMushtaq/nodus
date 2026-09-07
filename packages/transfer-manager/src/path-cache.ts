import type { PathCache, PathCacheEntry, TransferPath } from "./types.js";

/** In-memory path cache — Phase 14 plugs in IndexedDB/SQLite via the PathCache interface. */
export class InMemoryPathCache implements PathCache {
  private cache = new Map<string, PathCacheEntry>();

  get(nodeId: string): PathCacheEntry | undefined {
    return this.cache.get(nodeId);
  }

  set(nodeId: string, path: TransferPath): void {
    this.cache.set(nodeId, { path, lastSuccessAt: Date.now() });
  }

  evict(nodeId: string): void {
    this.cache.delete(nodeId);
  }
}
