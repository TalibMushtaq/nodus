// Browser AttemptPathFn for the Transfer Manager (Phase 13 fallback chain):
//   local_signaling -> relay_signaling -> buffer_relay -> local_queue
//
// Paths A/B negotiate a WebRTC data channel (direct shard transfer). Path C
// hands the shard to the Relay buffer via `postShard`. Path D enqueues it in
// IndexedDB for a later retry. A path that cannot run in this environment
// throws so the executor falls through to the next one.

import { NODUS_LOCAL_PORT } from "@repo/relay-client";
import { createLocalSignalingChannel } from "@repo/webrtc-transport";
import type { SignalingChannel } from "@repo/webrtc-transport";
import type { AttemptPathFn, LocalQueue, ShardTransferRequest, TransferPath, TransferResult } from "@repo/transfer-manager";

import { getTrustedNodes } from "../trusted-nodes";
import { canAttemptLocalPath, canAttemptRelaySignaling, getWebRtcCapabilities } from "../local-network";
import type { ShardUpload, ShardUploadResult } from "../buffer";
import { WebRtcSessionCache } from "./webrtc-session";

export interface BrowserAttemptPathDeps {
  postShard: (dto: ShardUpload) => Promise<ShardUploadResult>;
  localQueue: LocalQueue;
  /** This browser's device id, used as the local-signaling session identity. */
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
   * internal cache is used. The provider owns one and closes it on unmount so
   * peer connections and signaling sockets do not outlive the app session.
   */
  sessionCache?: WebRtcSessionCache;
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

async function resolveLocalChannel(request: ShardTransferRequest, deps: BrowserAttemptPathDeps): Promise<SignalingChannel> {
  const nodes = await getTrustedNodes();
  const host = nodes.find((n) => n.node_id === String(request.targetNode))?.host;
  if (!host) {
    throw new Error(`no trusted local host for node ${request.targetNode}`);
  }
  return createLocalSignalingChannel({
    baseUrl: `http://${host}:${NODUS_LOCAL_PORT}`,
    deviceId: deps.deviceId,
    sign: deps.signLocal,
  });
}

export function createBrowserAttemptPath(deps: BrowserAttemptPathDeps): AttemptPathFn {
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
        // Relay path reports in-shard bytes via XHR upload progress.
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
    const caps = getWebRtcCapabilities();
    const isLocal = path === "local_signaling";
    if (isLocal) {
      if (!canAttemptLocalPath(caps)) throw new Error("local signaling unavailable in this browser context");
    } else {
      if (!canAttemptRelaySignaling(caps)) throw new Error("WebRTC unavailable in this browser context");
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
