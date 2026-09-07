import type { TransferConfig } from "./types.js";

/** Default transfer manager configuration. */
export const DEFAULT_CONFIG: TransferConfig = {
  maxConcurrency: 4,
  localDiscoveryTimeoutMs: 2000,
  webrtcNegotiationTimeoutMs: 4000,
  relaySignalingTimeoutMs: 3000,
  backoffBaseMs: 500,
  backoffJitterMs: 300,
  maxRetriesPerStage: 2,
};

/** Merge user overrides onto defaults. */
export function makeConfig(overrides?: Partial<TransferConfig>): TransferConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
