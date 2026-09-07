import type { NodeId } from "@repo/protocol";
import type { ShardTransferRequest, TransferConfig, TransferResult } from "./types.js";
import { InMemoryPathCache } from "./path-cache.js";
import { MemoryLocalQueue } from "./local-queue.js";
import { ConcurrencyPool } from "./pool.js";
import { makeConfig } from "./config.js";
import type { AttemptPathFn } from "./executor.js";

/**
 * High-level transfer manager — the public entry point for shard transfers.
 *
 * Manages concurrency pool, path cache, and local queue. Transport logic
 * (WebRTC, relay, etc.) is injected via the `attemptPath` callback so
 * the manager itself has no platform dependencies.
 */
export class TransferManager {
  private cache: InMemoryPathCache;
  private queue: MemoryLocalQueue;
  private pool: ConcurrencyPool;
  private config: TransferConfig;

  constructor(
    attemptPath: AttemptPathFn,
    config?: Partial<TransferConfig>,
    cache?: InMemoryPathCache,
    queue?: MemoryLocalQueue,
  ) {
    this.config = makeConfig(config);
    this.cache = cache ?? new InMemoryPathCache();
    this.queue = queue ?? new MemoryLocalQueue();
    this.pool = new ConcurrencyPool(this.config, this.cache, attemptPath);

    // Process queued items when connectivity is restored
    this.queue.onConnectivityRestored(() => this.drainQueue());
  }

  /** Upload a shard to a target node. */
  uploadShard(request: ShardTransferRequest): Promise<TransferResult> {
    return this.pool.submit(request);
  }

  /** Download a shard from a source node. */
  downloadShard(request: ShardTransferRequest): Promise<TransferResult> {
    return this.pool.submit(request);
  }

  /** Enqueue a failed transfer for Path D retry. */
  enqueue(item: {
    transferId: string;
    fileId: string;
    versionNumber: number;
    shardIndex: number;
    data: Uint8Array;
    hash: string;
    targetNode: NodeId;
    sourceDevice?: string;
  }): void {
    this.queue.enqueue({
      ...item,
      enqueuedAt: Date.now(),
      retryCount: 0,
    });
  }

  /** Notify the manager that connectivity has been restored. */
  notifyConnectivityRestored(): void {
    this.queue.notifyConnectivityRestored();
  }

  /** Drain the local queue — called automatically on connectivity restoration. */
  private drainQueue(): void {
    while (this.queue.size > 0) {
      const item = this.queue.dequeue();
      if (!item) break;
      // Re-submit through the pool; if pool is full it queues internally
      this.pool.submit({
        transferId: item.transferId,
        fileId: item.fileId,
        versionNumber: item.versionNumber,
        shardIndex: item.shardIndex,
        data: item.data,
        hash: item.hash,
        targetNode: item.targetNode,
        sourceDevice: item.sourceDevice,
      });
    }
  }

  get activeCount(): number {
    return this.pool.activeCount;
  }

  get queuedCount(): number {
    return this.pool.queuedCount;
  }
}
