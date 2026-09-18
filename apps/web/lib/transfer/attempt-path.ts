// Browser binding for the shared @repo/sdk attempt-path chain.
//
// The fallback semantics (A → B → C → D) and the persistent-session logic live
// in the SDK; this file only supplies the browser-specific pieces: trusted-node
// host lookup from IndexedDB, the mixed-content/EventSource capability checks,
// and the Relay-buffer shard poster.

import { createAttemptPath } from "@repo/sdk";
import type { AttemptPathFn, LocalQueue } from "@repo/transfer-manager";
import type { SignalingChannel } from "@repo/webrtc-transport";

import { getTrustedNodes } from "../trusted-nodes";
import {
  canAttemptLocalPath,
  canAttemptRelaySignaling,
  getWebRtcCapabilities,
} from "../local-network";
import type { ShardUpload, ShardUploadResult } from "../buffer";
import { WebRtcSessionCache } from "./webrtc-session";

export interface BrowserAttemptPathDeps {
  postShard: (dto: ShardUpload) => Promise<ShardUploadResult>;
  localQueue: LocalQueue;
  /** This browser's device id, used as the local-signaling session identity. */
  deviceId: string;
  sourceDevice?: string;
  /**
   * Stateless-signing callback for local WebRTC signaling (the device's
   * non-extractable signer handle, ADR-0008). Without it the node rejects Path A
   * signaling (401) and the fallback chain advances to relay/buffer paths.
   */
  signLocal?: (message: string) => string | Promise<string>;
  /**
   * Relay-signaling channel factory (Path B). Optional: callers without a live
   * Relay WS client omit it, and Path B then throws so the chain falls to C.
   */
  createRelayChannel?: (targetNode: string) => SignalingChannel | null;
  /**
   * Whether the Relay socket is currently connected. Path B signals *through*
   * the Relay, so when it is down the attempt is skipped immediately instead
   * of paying a negotiation timeout per shard. Path A (LAN) ignores this.
   */
  isRelayAvailable?: () => boolean;
  /**
   * Whether the target node is currently online (from the Relay catalog). When
   * false, Paths A/B are skipped so an offline node falls straight to the Relay
   * buffer instead of paying a WebRTC negotiation timeout first.
   */
  isNodeOnline?: (targetNode: string) => boolean;
  /**
   * Persistent WebRTC sessions shared across shards. Optional; when omitted an
   * internal cache is used. The provider owns one and closes it on unmount so
   * peer connections and signaling sockets do not outlive the app session.
   */
  sessionCache?: WebRtcSessionCache;
}

export function createBrowserAttemptPath(deps: BrowserAttemptPathDeps): AttemptPathFn {
  return createAttemptPath({
    ...deps,
    // Capabilities are sampled per attempt, not captured once: a page can gain
    // or lose a peer connection (and mixed-content rules) across a session.
    canAttemptLocalPath: () => canAttemptLocalPath(getWebRtcCapabilities()),
    canAttemptRelaySignaling: () => canAttemptRelaySignaling(getWebRtcCapabilities()),
    resolveLocalHost: async (nodeId) =>
      (await getTrustedNodes()).find((n) => n.node_id === nodeId)?.host ?? null,
  });
}
