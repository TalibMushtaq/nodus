/**
 * Exponential backoff with jitter.
 *
 * delay = baseMs * 2^attempt + random(0, jitterMs)
 *
 * Both TS and Rust sides use identical formula and constants (see
 * docs/architecture/transfer-manager-spec.md).
 */
export function backoffDelay(attempt: number, baseMs: number, jitterMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * jitterMs;
  return exponential + jitter;
}

/** Sleep for the calculated backoff delay. */
export function sleepBackoff(attempt: number, baseMs: number, jitterMs: number): Promise<void> {
  const ms = backoffDelay(attempt, baseMs, jitterMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
