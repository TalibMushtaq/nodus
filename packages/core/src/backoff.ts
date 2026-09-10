/**
 * Exponential backoff with jitter.
 *
 * delay = baseMs * 2^attempt + random(0, jitterMs)
 *
 * Both TS and Rust sides use identical formula and constants (see
 * docs/architecture/transfer-manager-spec.md).
 *
 * Extracted from @repo/transfer-manager in Phase 14a so both transfer-manager
 * and relay-client share a single implementation.
 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  jitterMs: number,
): number {
  return backoffDelayWithRandom(attempt, baseMs, jitterMs);
}

/**
 * Testable variant that accepts an explicit random function. The public
 * `backoffDelay` delegates here with `Math.random` as the default, so
 * tests can seed determinism without touching global state.
 */
export function backoffDelayWithRandom(
  attempt: number,
  baseMs: number,
  jitterMs: number,
  randomFn: () => number = Math.random,
): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = randomFn() * jitterMs;
  return exponential + jitter;
}

/** Sleep for the calculated backoff delay. */
export function sleepBackoff(
  attempt: number,
  baseMs: number,
  jitterMs: number,
): Promise<void> {
  const ms = backoffDelay(attempt, baseMs, jitterMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
