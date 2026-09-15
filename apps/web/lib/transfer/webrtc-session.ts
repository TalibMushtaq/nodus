// Moved to @repo/sdk so web and native share one session/cache implementation;
// re-exported to keep existing imports (transfer-provider, tests) working.
export { PersistentWebRtcSession, WebRtcSessionCache } from "@repo/sdk";
export type {
  PersistentSessionDeps,
  PersistentShardRequest,
  PersistentShardResult,
} from "@repo/sdk";
