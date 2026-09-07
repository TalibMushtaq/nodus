import type { PathCache, ShardTransferRequest, TransferConfig, TransferResult } from "./types.js";
import { executeTransfer, type AttemptPathFn } from "./executor.js";

/**
 * Bounded concurrency pool for per-shard transfers.
 *
 * Each transfer runs its own independent fallback state machine.
 * Excess transfers are queued FIFO and picked up as slots free.
 */
export class ConcurrencyPool {
  private active = 0;
  private queue: Array<{
    request: ShardTransferRequest;
    resolve: (result: TransferResult) => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(
    private config: TransferConfig,
    private cache: PathCache,
    private attemptPath: AttemptPathFn,
  ) {}

  /** Submit a shard transfer. Resolves when the transfer completes. */
  submit(request: ShardTransferRequest): Promise<TransferResult> {
    return new Promise((resolve, reject) => {
      if (this.active < this.config.maxConcurrency) {
        this.active++;
        this.run(request, resolve, reject);
      } else {
        this.queue.push({ request, resolve, reject });
      }
    });
  }

  private async run(
    request: ShardTransferRequest,
    resolve: (r: TransferResult) => void,
    reject: (e: Error) => void,
  ): Promise<void> {
    try {
      const result = await executeTransfer(
        request,
        this.config,
        this.cache,
        this.attemptPath,
      );
      resolve(result);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.active--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.queue.length === 0 || this.active >= this.config.maxConcurrency) {
      return;
    }
    const next = this.queue.shift()!;
    this.active++;
    this.run(next.request, next.resolve, next.reject);
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }
}
