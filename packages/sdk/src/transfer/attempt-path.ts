// Platform-agnostic AttemptPathFn for the Transfer Manager (Phase 13 chain):
//   local_signaling -> relay_signaling -> buffer_relay -> local_queue
//
// Paths A/B negotiate a WebRTC data channel (direct shard transfer). Path C
// hands the shard to the Relay buffer via `postShard`. Path D enqueues it in the
// platform's persistent queue for a later retry. A path that cannot run in this
// environment throws so the executor falls through to the next one.
//
// Everything platform-specific is injected: the browser supplies mixed-content
// and EventSource capability checks plus IndexedDB; native supplies a
// react-native-webrtc factory and SQLite. Shared here so the fallback semantics
// (and their tests) exist once.

import { NODUS_LOCAL_PORT } from "@repo/relay-client";
import { createLocalSignalingChannel } from "@repo/webrtc-transport";
import type { PeerConnectionConfig, SignalingChannel } from "@repo/webrtc-transport";
import type {
  AttemptPathFn,
  LocalQueue,
  ShardTransferRequest,
  TransferPath,
  TransferResult,
} from "@repo/transfer-manager";

import { WebRtcSessionCache } from "./webrtc-session.js";

/** One encrypted shard destined for the Relay buffer (Path C). */
export interface BufferedShardUpload {
  fileId: string;
  versionNumber: number;
  shardIndex: number;
  /** BLAKE3 hex of the ciphertext body (not plaintext). */
  hash: string;
  size: number;
  targetNode: string;
  transferId: string;
  sourceDevice?: string;
  data: Uint8Array;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}

export interface AttemptPathDeps {
  postShard: (dto: BufferedShardUpload) => Promise<unknown>;
  localQueue: LocalQueue;
  /** This device's id, used as the local-signaling session identity. */
  deviceId: string;
  sourceDevice?: string;
  /**
   * Stateless-signing callback for local WebRTC signaling (`signDeviceMessage`
   * over the device private key). Without it the node rejects Path A signaling
   * (401) and the fallback chain advances to relay/buffer paths.
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
   * Persistent WebRTC sessions shared across shards. Optional; when omitted an
   * internal cache is used. The host owns one and closes it on unmount so peer
   * connections and signaling sockets do not outlive the app session.
   */
  sessionCache?: WebRtcSessionCache;
  /** LAN host for a trusted node id, or null when this device has not paired. */
  resolveLocalHost: (targetNode: string) => Promise<string | null>;
  /** Platform capability predicate for Path A (browser blocks https→http LAN). */
  canAttemptLocalPath: () => boolean;
  /** Platform capability predicate for Path B (needs a peer connection). */
  canAttemptRelaySignaling: () => boolean;
  /**
   * Whether the target node is currently online. When it reports false, the
   * direct paths (A/B) are skipped immediately: negotiating with an offline node
   * only burns the WebRTC timeout before Path C runs, which made relay fallback
   * feel slow. Unknown nodes are treated as online (the predicate is optional).
   */
  isNodeOnline?: (targetNode: string) => boolean;
  /**
   * Peer-connection constructor for direct paths. Browsers omit it (the global
   * `RTCPeerConnection` is used); native injects react-native-webrtc.
   */
  peerConnectionFactory?: (config: RTCConfiguration) => RTCPeerConnection;
  /** ICE/STUN overrides for direct paths. */
  peerConnectionConfig?: PeerConnectionConfig;
}

function toResult(
  request: ShardTransferRequest,
  path: TransferPath,
  startedAt: number,
  success: boolean,
  error?: string,
): TransferResult {
  return {
    path,
    durationMs: Date.now() - startedAt,
    transferId: request.transferId,
    bytesTransferred: success ? request.data.length : 0,
    success,
    error,
  };
}

async function resolveLocalChannel(
  request: ShardTransferRequest,
  deps: AttemptPathDeps,
): Promise<SignalingChannel> {
  const host = await deps.resolveLocalHost(String(request.targetNode));
  if (!host) {
    throw new Error(`no trusted local host for node ${request.targetNode}`);
  }
  return createLocalSignalingChannel({
    baseUrl: `http://${host}:${NODUS_LOCAL_PORT}`,
    deviceId: deps.deviceId,
    sign: deps.signLocal,
  });
}

export function createAttemptPath(deps: AttemptPathDeps): AttemptPathFn {
  const sessions = deps.sessionCache ?? new WebRtcSessionCache();
  return async (request, path) => {
    const startedAt = Date.now();

    if (path === "buffer_relay") {
      await deps.postShard({
        fileId: request.fileId,
        versionNumber: request.versionNumber,
        shardIndex: request.shardIndex,
        hash: request.hash,
        size: request.data.length,
        targetNode: String(request.targetNode),
        transferId: request.transferId,
        sourceDevice: deps.sourceDevice,
        data: request.data,
        // Relay path reports in-shard bytes via upload progress.
        onProgress: request.onProgress,
      });
      return toResult(request, path, startedAt, true);
    }

    if (path === "local_queue") {
      deps.localQueue.enqueue({
        transferId: request.transferId,
        fileId: request.fileId,
        versionNumber: request.versionNumber,
        shardIndex: request.shardIndex,
        data: request.data,
        hash: request.hash,
        targetNode: request.targetNode,
        sourceDevice: deps.sourceDevice,
        enqueuedAt: Date.now(),
        retryCount: 0,
      });
      return toResult(request, path, startedAt, true);
    }

    // Path A/B: WebRTC. Capability or host failures throw to advance the chain.
    // An offline node is skipped before any negotiation so the relay buffer
    // (Path C) is reached at once instead of after a WebRTC timeout.
    if (deps.isNodeOnline && !deps.isNodeOnline(String(request.targetNode))) {
      throw new Error("target node is offline; using the relay buffer");
    }
    const isLocal = path === "local_signaling";
    if (isLocal) {
      if (!deps.canAttemptLocalPath()) {
        throw new Error("local signaling unavailable in this browser context");
      }
    } else {
      if (!deps.canAttemptRelaySignaling()) {
        throw new Error("WebRTC unavailable in this browser context");
      }
      if (!deps.createRelayChannel) throw new Error("relay signaling channel unavailable");
      if (deps.isRelayAvailable && !deps.isRelayAvailable()) {
        throw new Error("relay is not connected");
      }
    }

    // One session per (path, node): negotiate once, then stream every shard of
    // the transfer over the same data channel. Capability/host failures above
    // happen before any session is created, so the chain falls through cleanly.
    const key = `${path}:${request.targetNode}`;
    // Skip a recent negotiation failure rather than retrying the full timeout
    // on every shard; the cooldown is short so a recovered node is retried.
    if (!sessions.isAvailable(key)) throw new Error("WebRTC session recently failed");

    const session = sessions.get(key, () => ({
      createChannel: () => {
        if (isLocal) return resolveLocalChannel(request, deps);
        const channel = deps.createRelayChannel!(String(request.targetNode));
        if (!channel) throw new Error("relay signaling channel unavailable");
        return channel;
      },
      peerConnectionFactory: deps.peerConnectionFactory,
      peerConnectionConfig: deps.peerConnectionConfig,
    }));

    try {
      const result = await session.send({
        transferId: request.transferId,
        fileId: request.fileId,
        versionNumber: request.versionNumber,
        shardIndex: request.shardIndex,
        data: request.data,
        hash: request.hash,
        targetNode: request.targetNode ? String(request.targetNode) : undefined,
        sourceDevice: deps.sourceDevice,
        // sendShard streams 16 KB chunks and reports in-shard byte progress.
        onProgress: request.onProgress,
      });
      return {
        path,
        durationMs: result.durationMs,
        transferId: request.transferId,
        bytesTransferred: result.bytesTransferred,
        success: true,
      };
    } catch (err) {
      // A failed direct transfer means this path is not working for this node
      // right now. Drop the session and cool the path down so the remaining
      // shards fall straight through to Path C instead of each paying another
      // negotiation + ack timeout while every concurrency slot waits on it.
      sessions.markUnavailable(key);
      sessions.evict(key);
      throw err;
    }
  };
}
