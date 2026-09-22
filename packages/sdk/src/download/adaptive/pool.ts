// Global adaptive limiter shared by every concurrent download in a client.
//
// One instance per app (web `DownloadProvider`, mobile runtime) so parallel
// shards across several files and folder-zip iterations draw from a single
// budget — otherwise two files would each ramp to `max` and double the socket
// pressure the controller is trying to manage. The controller adjusts `limit`
// from measured goodput; `acquire` blocks when `active` has reached it.

import { AdaptiveConcurrencyController } from "./controller.js";
import { ThroughputSampler } from "./sampler.js";
import {
  bytesPerSecondToMbps,
  resolveLimiterBounds,
  type DownloadLimiterOptions,
  type ResolvedLimiterBounds,
} from "./types.js";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class DownloadLimiter {
  private readonly sampler: ThroughputSampler;
  private readonly controller: AdaptiveConcurrencyController;
  private readonly bounds: ResolvedLimiterBounds;
  private active = 0;
  private waiters: Waiter[] = [];

  constructor(options: DownloadLimiterOptions = {}) {
    const now = options.now ?? (() => Date.now());
    this.sampler = new ThroughputSampler(now);
    this.bounds = resolveLimiterBounds(options);
    // On a limit increase, wake queued workers so the new capacity is used on
    // the current download rather than only the next one.
    this.controller = new AdaptiveConcurrencyController(
      this.bounds,
      this.sampler,
      now,
      (limit, mbps) => {
        this.pump();
        options.onConcurrencyChange?.(limit, mbps);
      },
    );
  }

  /** Current in-flight shard allowance (changes as the controller probes). */
  get limit(): number {
    return this.controller.currentLimit;
  }

  /** Hard ceiling; callers spawn this many worker loops and let `acquire` gate them. */
  get max(): number {
    return this.bounds.max;
  }

  get activeCount(): number {
    return this.active;
  }

  /** Smoothed goodput, bytes/second (display only). */
  get bytesPerSecond(): number {
    return this.sampler.bytesPerSecond;
  }

  /** Smoothed goodput, megabits/second (display only). */
  get mbps(): number {
    return bytesPerSecondToMbps(this.sampler.bytesPerSecond);
  }

  /** Claim a slot. Resolves with a release fn; rejects when `signal` aborts. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("download aborted before acquiring a slot"));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (this.active < this.controller.currentLimit) {
        this.active += 1;
        resolve(this.makeRelease());
        return;
      }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("download aborted while waiting for a slot"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** Report bytes that arrived for the sampler (per chunk). */
  recordBytes(bytes: number, atMs?: number): void {
    this.sampler.record(bytes, atMs);
  }

  /** Report one completed shard so the controller can probe. */
  recordShardComplete(atMs?: number): void {
    this.controller.onShardComplete(atMs);
  }

  /** Report a failed shard so the controller backs off. */
  recordError(): void {
    this.sampler.recordError();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.pump();
    };
  }

  private pump(): void {
    while (this.waiters.length > 0 && this.active < this.controller.currentLimit) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(new Error("download aborted while waiting for a slot"));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.makeRelease());
    }
  }
}
