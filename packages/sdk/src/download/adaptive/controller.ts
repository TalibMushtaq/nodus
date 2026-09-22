// AIMD controller for the global download limiter.
//
// Mirrors TCP congestion control: probe upward one permit at a time while
// goodput keeps improving, halve on a meaningful regression or on errors. The
// point is to find the link's actual capacity (a home Wi-Fi link may sustain 8+
// parallel shards; a Relay pull-through plateaus at ~1) instead of a hardcoded
// count that is wrong for one of them.

import type { ThroughputSampler } from "./sampler.js";
import {
  bytesPerSecondToMbps,
  type ResolvedLimiterBounds,
} from "./types.js";

/** Probe after this many shard completions, or after this long without one. */
export const PROBE_COMPLETIONS = 2;
export const PROBE_INTERVAL_MS = 1000;
/** Goodput must improve by this fraction to justify another permit. */
export const IMPROVE_RATIO = 1.1;
/** A drop past this fraction triggers a multiplicative decrease. */
export const DECREASE_RATIO = 0.8;
/** Hold the new limit for this long after a probe to avoid oscillation. */
export const COOLDOWN_MS = 1000;

export class AdaptiveConcurrencyController {
  private limit: number;
  private prevBps: number | null = null;
  private completionsSinceProbe = 0;
  private lastProbeAt: number;
  private cooldownUntil = 0;

  constructor(
    private readonly bounds: ResolvedLimiterBounds,
    private readonly sampler: ThroughputSampler,
    private readonly now: () => number,
    private readonly onChange?: (limit: number, mbps: number) => void,
  ) {
    this.limit = bounds.start;
    this.lastProbeAt = now();
  }

  get currentLimit(): number {
    return this.limit;
  }

  /** Notify that one shard finished; may trigger a probe. */
  onShardComplete(atMs: number = this.now()): void {
    this.completionsSinceProbe += 1;
    if (
      this.completionsSinceProbe >= PROBE_COMPLETIONS ||
      atMs - this.lastProbeAt >= PROBE_INTERVAL_MS
    ) {
      this.probe(atMs);
    }
  }

  private probe(atMs: number): void {
    if (atMs < this.cooldownUntil) return;
    this.completionsSinceProbe = 0;
    this.lastProbeAt = atMs;

    const bps = this.sampler.bytesPerSecond;
    const errors = this.sampler.errorCount;
    const previous = this.prevBps;
    let next = this.limit;

    if (errors > 0) {
      // Any failure is a strong "we are past capacity" signal.
      next = Math.max(this.bounds.min, Math.ceil(this.limit / 2));
    } else if (previous !== null && bps > previous * IMPROVE_RATIO) {
      next = Math.min(this.bounds.max, this.limit + 1);
    } else if (previous !== null && bps < previous * DECREASE_RATIO) {
      next = Math.max(this.bounds.min, Math.ceil(this.limit / 2));
    }

    this.prevBps = bps;
    this.sampler.resetErrors();

    if (next !== this.limit) {
      this.limit = next;
      this.cooldownUntil = atMs + COOLDOWN_MS;
      this.onChange?.(this.limit, bytesPerSecondToMbps(bps));
    }
  }
}
