import { DEFAULT_CONFIG, backoffDelay } from "@repo/transfer-manager";

interface TimingResult {
  scenario: string;
  measuredMs: number;
  expectedMs: number;
  pass: boolean;
}

/**
 * Measures the deterministic parts of the transfer manager's timing
 * contract: exponential backoff growth and the per-stage timeout table.
 * This is the CI-runnable half of the benchmarks — real-network WebRTC
 * negotiation timing lives in the browser harness (bench.html).
 */
export function runTimingBenchmarks(): TimingResult[] {
  const results: TimingResult[] = [];

  // Backoff: delay must be base * 2^attempt + [0, jitter).
  // We compare the lower bound (base * 2^attempt) so the run is stable.
  for (const attempt of [0, 1, 2, 3]) {
    const expected = DEFAULT_CONFIG.backoffBaseMs * Math.pow(2, attempt);
    const measured = backoffDelay(
      attempt,
      DEFAULT_CONFIG.backoffBaseMs,
      DEFAULT_CONFIG.backoffJitterMs,
    );
    results.push({
      scenario: `backoff_attempt_${attempt}`,
      measuredMs: measured,
      expectedMs: expected,
      pass: measured >= expected,
    });
  }

  results.push(
    {
      scenario: "local_discovery_timeout",
      measuredMs: DEFAULT_CONFIG.localDiscoveryTimeoutMs,
      expectedMs: 2000,
      pass: DEFAULT_CONFIG.localDiscoveryTimeoutMs === 2000,
    },
    {
      scenario: "webrtc_negotiation_timeout",
      measuredMs: DEFAULT_CONFIG.webrtcNegotiationTimeoutMs,
      expectedMs: 4000,
      pass: DEFAULT_CONFIG.webrtcNegotiationTimeoutMs === 4000,
    },
    {
      scenario: "relay_signaling_timeout",
      measuredMs: DEFAULT_CONFIG.relaySignalingTimeoutMs,
      expectedMs: 3000,
      pass: DEFAULT_CONFIG.relaySignalingTimeoutMs === 3000,
    },
    {
      scenario: "max_concurrency",
      measuredMs: DEFAULT_CONFIG.maxConcurrency,
      expectedMs: 4,
      pass: DEFAULT_CONFIG.maxConcurrency === 4,
    },
  );

  return results;
}