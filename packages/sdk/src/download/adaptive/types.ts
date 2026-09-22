// Configuration and bounds for the adaptive download pool.
//
// Downloads were serial (one 8 MB shard in flight); a fast LAN link left most
// of the pipe idle. The pool below raises concurrency while measured goodput is
// still climbing and backs off when it is not — TCP-style AIMD — so throughput
// adapts to the network without a per-transport fixed worker count.

/** Caller-supplied bounds for the global download limiter. */
export interface DownloadLimiterOptions {
  /** Floor for the in-flight shard count. Default 1. */
  min?: number;
  /** Ceiling for the in-flight shard count. Default 16. */
  max?: number;
  /** Where ramp-up begins. Default 2 (probe upward, not straight to max). */
  start?: number;
  /**
   * Fired whenever the effective limit changes. Advisory: the limiter never
   * awaits it, and a throwing subscriber is ignored.
   */
  onConcurrencyChange?: (limit: number, mbps: number) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Bounds resolved from {@link DownloadLimiterOptions} with defaults applied. */
export interface ResolvedLimiterBounds {
  min: number;
  max: number;
  start: number;
}

export const DEFAULT_LIMITER_BOUNDS: ResolvedLimiterBounds = {
  min: 1,
  max: 16,
  start: 2,
};

export function resolveLimiterBounds(options: DownloadLimiterOptions = {}): ResolvedLimiterBounds {
  const min = Math.max(1, Math.floor(options.min ?? DEFAULT_LIMITER_BOUNDS.min));
  const max = Math.max(min, Math.floor(options.max ?? DEFAULT_LIMITER_BOUNDS.max));
  const start = Math.min(max, Math.max(min, Math.floor(options.start ?? DEFAULT_LIMITER_BOUNDS.start)));
  return { min, max, start };
}

/** Convert bytes/second to megabits/second (bits, for the conventional label). */
export function bytesPerSecondToMbps(bytesPerSecond: number): number {
  return (bytesPerSecond * 8) / 1_000_000;
}
