// Rolling goodput estimator for the adaptive download controller.
//
// The old `download-metrics.ts` average is display-only: it reads 0 between
// shards and spikes on arrival, so it cannot drive a control loop. This sample
// uses a short window over arriving chunks (each transport already reports
// per-chunk progress) and EWMA-smooths the instantaneous rate, giving the
// controller a signal that tracks the link rather than the shard boundary.

/** Width of the goodput window. Short enough to react, long enough to smooth. */
export const SAMPLER_WINDOW_MS = 1000;
/** EWMA weight for the newest instantaneous rate. */
export const SAMPLER_EWMA_ALPHA = 0.3;
/**
 * Minimum elapsed coverage before a rate estimate is trusted. A single chunk
 * recorded at the same instant as the first one would otherwise divide by ~1 ms
 * and report an absurd spike, which the EWMA would then carry for a while.
 */
export const SAMPLER_MIN_COVERAGE_MS = 50;

export class ThroughputSampler {
  private samples: Array<{ atMs: number; bytes: number }> = [];
  private ewmaBps = 0;
  private errors = 0;
  /** First byte ever recorded; the denominator floor before a full window. */
  private firstAtMs: number | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Record `bytes` that arrived at `atMs` (defaults to now). */
  record(bytes: number, atMs: number = this.now()): void {
    if (bytes <= 0) return;
    if (this.firstAtMs === null) this.firstAtMs = atMs;
    this.samples.push({ atMs, bytes });
    this.prune(atMs);
    const total = this.samples.reduce((sum, sample) => sum + sample.bytes, 0);
    // Denominator: elapsed coverage, capped at the window width. Before a full
    // window exists this is a cumulative average (stable startup estimate);
    // after it, it is bytes-in-last-window / window. A long idle gap prunes all
    // samples, so the rate decays toward zero rather than sticking.
    const coverageMs = Math.min(SAMPLER_WINDOW_MS, Math.max(1, atMs - this.firstAtMs));
    if (coverageMs < SAMPLER_MIN_COVERAGE_MS) return;
    const instantaneousBps = (total * 1000) / coverageMs;
    this.ewmaBps =
      this.ewmaBps === 0
        ? instantaneousBps
        : SAMPLER_EWMA_ALPHA * instantaneousBps + (1 - SAMPLER_EWMA_ALPHA) * this.ewmaBps;
  }

  /** Record a failed shard transfer; the controller backs off on these. */
  recordError(): void {
    this.errors += 1;
  }

  /** Smoothed goodput in bytes/second. */
  get bytesPerSecond(): number {
    return this.ewmaBps;
  }

  /** Errors observed since the last probe (reset by the controller). */
  get errorCount(): number {
    return this.errors;
  }

  resetErrors(): void {
    this.errors = 0;
  }

  private prune(atMs: number): void {
    const cutoff = atMs - SAMPLER_WINDOW_MS;
    while (this.samples.length > 0 && this.samples[0]!.atMs < cutoff) {
      this.samples.shift();
    }
  }
}
