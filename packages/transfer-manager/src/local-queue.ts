import type { LocalQueue, QueueItem } from "./types.js";

/** In-memory queue for Path D. No persistence — platform backends plug in later. */
export class MemoryLocalQueue implements LocalQueue {
  private items: QueueItem[] = [];
  private listeners: Array<() => void> = [];

  enqueue(item: QueueItem): void {
    this.items.push(item);
  }

  dequeue(): QueueItem | undefined {
    return this.items.shift();
  }

  peek(): QueueItem | undefined {
    return this.items[0];
  }

  remove(transferId: string): void {
    this.items = this.items.filter((i) => i.transferId !== transferId);
  }

  onConnectivityRestored(callback: () => void): void {
    this.listeners.push(callback);
  }

  /** Call when connectivity is restored to trigger queued retries. */
  notifyConnectivityRestored(): void {
    for (const cb of this.listeners) {
      cb();
    }
  }

  get size(): number {
    return this.items.length;
  }
}
