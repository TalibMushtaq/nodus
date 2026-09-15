// SQLite-backed Path D queue.
//
// The transfer-manager's LocalQueue contract is synchronous (the executor
// enqueues and moves on), so this keeps an in-memory mirror for reads and
// fire-and-forget persistence for writes, exactly like the web IndexedDB queue.
// The `pending` chain serializes writes so a later write cannot land before an
// earlier one, and `whenPersisted()` lets a caller await durability.

import type { LocalQueue, QueueItem } from "@repo/transfer-manager";

import { getDb } from "./db";

interface QueueRow {
  transfer_id: string;
  file_id: string;
  version_number: number;
  shard_index: number;
  data: Uint8Array;
  hash: string;
  target_node: string;
  source_device: string | null;
  enqueued_at: number;
  retry_count: number;
}

function toItem(row: QueueRow): QueueItem {
  return {
    transferId: row.transfer_id,
    fileId: row.file_id,
    versionNumber: row.version_number,
    shardIndex: row.shard_index,
    data: row.data,
    hash: row.hash,
    // target_node is the branded NodeId; the DB stores it as text.
    targetNode: row.target_node as unknown as QueueItem["targetNode"],
    sourceDevice: row.source_device ?? undefined,
    enqueuedAt: row.enqueued_at,
    retryCount: row.retry_count,
  };
}

export class SqliteLocalQueue implements LocalQueue {
  private items: QueueItem[] = [];
  private listeners: (() => void)[] = [];
  private pending: Promise<unknown> = Promise.resolve();

  /** Load persisted items once at startup, oldest first (FIFO retry order). */
  async hydrate(): Promise<void> {
    const db = await getDb();
    const rows = await db.getAllAsync<QueueRow>(
      "SELECT * FROM transfer_queue ORDER BY enqueued_at ASC",
    );
    this.items = rows.map(toItem);
  }

  private track(work: Promise<unknown>): void {
    // Swallow individual write failures: a dropped persistence step must not
    // reject the chain and block every future write.
    this.pending = this.pending.then(() => work).catch(() => undefined);
  }

  enqueue(item: QueueItem): void {
    this.items.push(item);
    this.track(
      (async () => {
        const db = await getDb();
        await db.runAsync(
          `INSERT OR REPLACE INTO transfer_queue
             (transfer_id, file_id, version_number, shard_index, data, hash, target_node, source_device, enqueued_at, retry_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          item.transferId,
          item.fileId,
          item.versionNumber,
          item.shardIndex,
          item.data,
          item.hash,
          String(item.targetNode),
          item.sourceDevice ?? null,
          item.enqueuedAt,
          item.retryCount,
        );
      })(),
    );
  }

  dequeue(): QueueItem | undefined {
    const item = this.items.shift();
    if (item) this.track(this.deleteRow(item.transferId));
    return item;
  }

  peek(): QueueItem | undefined {
    return this.items[0];
  }

  remove(transferId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.transferId !== transferId);
    if (this.items.length !== before) this.track(this.deleteRow(transferId));
  }

  /** True when a file already has queued shards (used to avoid duplicate rows). */
  hasFile(fileId: string): boolean {
    return this.items.some((i) => i.fileId === fileId);
  }

  onConnectivityRestored(callback: () => void): void {
    this.listeners.push(callback);
  }

  /** Call when connectivity returns to trigger queued retries. */
  notifyConnectivityRestored(): void {
    for (const cb of this.listeners) cb();
  }

  get size(): number {
    return this.items.length;
  }

  /** Resolves once every queued write has been persisted (tests/shutdown). */
  whenPersisted(): Promise<unknown> {
    return this.pending;
  }

  async clear(): Promise<void> {
    this.items = [];
    const db = await getDb();
    await db.runAsync("DELETE FROM transfer_queue");
  }

  private async deleteRow(transferId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync("DELETE FROM transfer_queue WHERE transfer_id = ?", transferId);
  }
}
