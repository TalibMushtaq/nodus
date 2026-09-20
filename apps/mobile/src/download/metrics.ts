// Average-throughput/ETA estimate for an in-flight download.
//
// The SDK reports bytes once per shard (not per chunk), so this is an average
// over wall-clock time rather than an instantaneous sample: a short-window
// sampler would read 0 between shards and spike on arrival. `etaSeconds` is
// null until there is both progress and a known total.

export function downloadMetrics(input: {
  startedAt: number;
  completedBytes: number;
  totalBytes: number;
}): { speedBps: number; etaSeconds: number | null } {
  const elapsed = (Date.now() - input.startedAt) / 1000;
  if (elapsed <= 0 || input.completedBytes <= 0) return { speedBps: 0, etaSeconds: null };
  const speedBps = input.completedBytes / elapsed;
  const remaining = input.totalBytes - input.completedBytes;
  const etaSeconds = speedBps > 0 && remaining > 0 ? remaining / speedBps : null;
  return { speedBps, etaSeconds };
}
