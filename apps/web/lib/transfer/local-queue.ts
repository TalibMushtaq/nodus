// IndexedDB-backed local queue for Path D (Relay and node both unavailable).
// The transfer-manager LocalQueue interface is synchronous, so this keeps an
// in-memory mirror and persists each mutation; `whenPersisted()` lets callers
// (and tests) await durability. Queue bytes are stored as Uint8Array, which
// IndexedDB structured-clones natively.

import type { LocalQueue, QueueItem } from "@repo/transfer-manager";
import { STORE_TRANSFER_QUEUE, idbClear, idbDelete, idbGetAll, idbPut } from "../db";

export class IndexedDBLocalQueue implements LocalQueue {
  private items: QueueItem[] = [];
  private listeners: Array<() => void> = [];
  private pending: Promise<unknown> = Promise.resolve();

  /** Load persisted items in enqueue order. Call before use. */
  async hydrate(): Promise<void> {
    const rows = await idbGetAll<QueueItem>(STORE_TRANSFER_QUEUE);
    this.items = rows.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  /** Serialize writes so the on-disk order matches the in-memory order. */
  private track(work: Promise<unknown>): void {
    this.pending = this.pending.then(() => work).catch(() => undefined);
  }

  enqueue(item: QueueItem): void {
    this.items.push(item);
    this.track(idbPut(STORE_TRANSFER_QUEUE, item));
  }

  dequeue(): QueueItem | undefined {
    const item = this.items.shift();
    if (item) this.track(idbDelete(STORE_TRANSFER_QUEUE, item.transferId));
    return item;
  }

  peek(): QueueItem | undefined {
    return this.items[0];
  }

  remove(transferId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.transferId !== transferId);
    if (this.items.length !== before) this.track(idbDelete(STORE_TRANSFER_QUEUE, transferId));
  }

  onConnectivityRestored(callback: () => void): void {
    this.listeners.push(callback);
  }

  /** Trigger queued retries (called when connectivity returns). */
  notifyConnectivityRestored(): void {
    for (const cb of this.listeners) cb();
  }

  get size(): number {
    return this.items.length;
  }

  /** Resolve once every queued write has been committed. */
  whenPersisted(): Promise<unknown> {
    return this.pending;
  }

  async clear(): Promise<void> {
    this.items = [];
    await idbClear(STORE_TRANSFER_QUEUE);
  }
}
