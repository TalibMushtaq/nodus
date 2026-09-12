import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  STORE_KEYS,
  STORE_UPLOAD_PROGRESS,
  WEB_DB_NAME,
  WEB_STORES,
  openWebDb,
} from "../db";
import { getCursors, getCursor, nextOriginSequence, resyncOriginSequence } from "../sync-state";
import { deleteFileKey, getFileKey, putFileKey } from "../keys";
import { addTrustedNode, getTrustedNodes } from "../trusted-nodes";
import { getCachedCatalog, toCatalogEntry, upsertCatalogEntries, getCachedFolders, upsertFolders } from "../catalog";
import type { RelayFile } from "../catalog";
import { IndexedDBPathCache } from "../transfer/path-cache";
import { IndexedDBLocalQueue } from "../transfer/local-queue";
import {
  clearUploadProgress,
  getUploadProgress,
  listIncompleteUploads,
  markShardComplete,
  saveUploadProgress,
} from "../upload-progress";

function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(WEB_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await deleteDb();
});

describe("web local DB", () => {
  it("creates every store on open", async () => {
    const db = await openWebDb();
    const names = Array.from(db.objectStoreNames);
    db.close();
    for (const store of WEB_STORES) {
      expect(names).toContain(store);
    }
  });

  it("allocates unique, strictly increasing origin sequences under concurrency", async () => {
    const seqs = await Promise.all(Array.from({ length: 25 }, () => nextOriginSequence("device-A")));
    expect(new Set(seqs).size).toBe(25);
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await getCursor("device-A")).toBe(25);
  });

  it("re-syncs a cursor from the server value", async () => {
    await nextOriginSequence("device-B");
    await resyncOriginSequence("device-B", 42);
    expect(await getCursor("device-B")).toBe(42);
    // The next allocation continues from the server cursor, not the stale one.
    expect(await nextOriginSequence("device-B")).toBe(43);
    expect((await getCursors()).map((c) => c.origin_id)).toContain("device-B");
  });

  it("round-trips a file encryption key", async () => {
    const fek = new Uint8Array([1, 2, 3, 4]);
    await putFileKey("file-1", fek);
    // Normalize through Array.from: fake-indexeddb returns a Uint8Array from a
    // different realm, which deep-equality otherwise treats as unequal.
    const stored = await getFileKey("file-1");
    expect(Array.from(stored ?? [])).toEqual([1, 2, 3, 4]);
    await deleteFileKey("file-1");
    expect(await getFileKey("file-1")).toBeUndefined();
  });

  it("round-trips trusted nodes via the shared opener", async () => {
    await addTrustedNode({ node_id: "n1", host: "192.168.1.5", account_id: "a1", device_id: "d1", paired_at: "2026-09-12T00:00:00Z" });
    const nodes = await getTrustedNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.node_id).toBe("n1");
  });

  it("caches a catalog entry with a storage status rollup", async () => {
    const file: RelayFile = {
      file_id: "file-2",
      parent_folder_id: null,
      encrypted_name: "cipher",
      created_at: "2026-09-12T00:00:00Z",
      updated_at: "2026-09-12T00:00:00Z",
      versions: [{ version_number: 1, shard_count: 2, version_hash: "vh", conflict_status: "none", created_at: "2026-09-12T00:00:00Z" }],
      locations: [
        { version_number: 1, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: "h0", size_bytes: 10 },
        { version_number: 1, shard_index: 1, node_id: "n1", status: "RELAY_BUFFERED", hash: "h1", size_bytes: 10 },
      ],
    };
    expect(toCatalogEntry(file).storage_status).toBe("buffered");
    await upsertCatalogEntries([file]);
    const cached = await getCachedCatalog();
    expect(cached).toHaveLength(1);
    expect(cached[0]!.latest_version_number).toBe(1);

    const allStored = { ...file, locations: file.locations.map((l) => ({ ...l, status: "NODE_STORED" })) };
    expect(toCatalogEntry(allStored).storage_status).toBe("stored");
  });

  it("caches the folder tree", async () => {
    await upsertFolders([
      { folder_id: "dir-1", parent_folder_id: null, encrypted_name: "enc", created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" },
    ]);
    const folders = await getCachedFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0]!.folder_id).toBe("dir-1");
  });

  it("persists and reloads the path cache", async () => {
    const cache = new IndexedDBPathCache();
    cache.set("node-1", "relay_signaling");
    const reloaded = new IndexedDBPathCache();
    await reloaded.hydrate();
    expect(reloaded.get("node-1")?.path).toBe("relay_signaling");
    reloaded.evict("node-1");
    const empty = new IndexedDBPathCache();
    await empty.hydrate();
    expect(empty.get("node-1")).toBeUndefined();
  });

  it("persists the local queue in enqueue order", async () => {
    const queue = new IndexedDBLocalQueue();
    queue.enqueue({ transferId: "t2", fileId: "f", versionNumber: 1, shardIndex: 1, data: new Uint8Array([2]), hash: "h2", targetNode: "n1" as never, enqueuedAt: 20, retryCount: 0 });
    queue.enqueue({ transferId: "t1", fileId: "f", versionNumber: 1, shardIndex: 0, data: new Uint8Array([1]), hash: "h1", targetNode: "n1" as never, enqueuedAt: 10, retryCount: 0 });
    await queue.whenPersisted();

    const reloaded = new IndexedDBLocalQueue();
    await reloaded.hydrate();
    expect(reloaded.peek()?.transferId).toBe("t1");
    expect(reloaded.size).toBe(2);
    reloaded.dequeue();
    await reloaded.whenPersisted();
    expect(reloaded.size).toBe(1);
  });

  it("tracks resumable upload progress", async () => {
    const now = new Date().toISOString();
    await saveUploadProgress({ transferId: "file-3:1", fileId: "file-3", versionNumber: 1, targetNode: "n1", totalShards: 3, versionHash: "vh", encryptedName: "enc", announced: true, completedShards: [], createdAt: now, updatedAt: now });
    await markShardComplete("file-3", 1, 0);
    await markShardComplete("file-3", 1, 0); // idempotent
    await markShardComplete("file-3", 1, 2);
    const progress = await getUploadProgress("file-3", 1);
    expect(progress?.completedShards).toEqual([0, 2]);

    const incomplete = await listIncompleteUploads();
    expect(incomplete.map((p) => p.fileId)).toEqual(["file-3"]);

    await clearUploadProgress("file-3", 1);
    expect(await getUploadProgress("file-3", 1)).toBeUndefined();
  });

  it("exposes the upload progress store constant", () => {
    expect(STORE_UPLOAD_PROGRESS).toBe("upload_progress");
    expect(STORE_KEYS).toBe("keys");
  });
});
