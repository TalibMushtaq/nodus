import type { PathCache, ShardTransferRequest, TransferConfig, TransferPath, TransferResult } from "./types.js";
import { sleepBackoff } from "./backoff.js";

/** Ordered fallback chain — first path in the array is tried first. */
const FALLBACK_CHAIN: TransferPath[] = [
  "local_signaling",
  "relay_signaling",
  "buffer_relay",
  "local_queue",
];

/** Paths whose success should be cached (high-quality, direct paths). */
const CACHABLE_PATHS = new Set<TransferPath>(["local_signaling", "relay_signaling"]);

/**
 * Attempt a single transfer path. The caller supplies the actual transport
 * logic — this module handles retry/backoff/fallback, not the WebRTC/relay
 * details.
 */
export type AttemptPathFn = (
  request: ShardTransferRequest,
  path: TransferPath,
) => Promise<TransferResult>;

/**
 * Execute the full fallback chain for a single shard transfer.
 *
 * Returns on first success or after all paths are exhausted.
 */
export async function executeTransfer(
  request: ShardTransferRequest,
  config: TransferConfig,
  cache: PathCache,
  attemptPath: AttemptPathFn,
): Promise<TransferResult> {
  const nodeId = request.targetNode;

  // Check path cache — if a known-good path exists, try it first
  const cached = cache.get(nodeId);
  let chain: TransferPath[];
  if (cached) {
    // Attempt cached path before the full chain
    chain = [cached.path, ...FALLBACK_CHAIN.filter((p) => p !== cached.path)];
  } else {
    chain = [...FALLBACK_CHAIN];
  }

  let lastResult: TransferResult | undefined;

  for (const path of chain) {
    for (let attempt = 0; attempt <= config.maxRetriesPerStage; attempt++) {
      if (attempt > 0) {
        await sleepBackoff(attempt - 1, config.backoffBaseMs, config.backoffJitterMs);
      }

      const result = await attemptPath(request, path);

      if (result.success) {
        // Cache successful high-quality paths
        if (CACHABLE_PATHS.has(path)) {
          cache.set(nodeId, path);
        }
        return result;
      }

      lastResult = result;

      // If the cached path failed, evict immediately and don't retry it
      if (cached && path === cached.path) {
        cache.evict(nodeId);
        break; // Fall through to next path
      }
    }
  }

  return (
    lastResult ?? {
      path: "local_queue",
      durationMs: 0,
      transferId: request.transferId,
      bytesTransferred: 0,
      success: false,
      error: "all paths exhausted",
    }
  );
}

export { FALLBACK_CHAIN };
