// Browser AttemptPathFn for the Transfer Manager (Phase 13 fallback chain):
//   local_signaling -> relay_signaling -> buffer_relay -> local_queue
//
// Paths A/B negotiate a WebRTC data channel (direct shard transfer). Path C
// hands the shard to the Relay buffer via `postShard`. Path D enqueues it in
// IndexedDB for a later retry. A path that cannot run in this environment
// throws so the executor falls through to the next one.

import { NODUS_LOCAL_PORT } from "@repo/relay-client";
import { createLocalSignalingChannel, transferShardViaWebRtc } from "@repo/webrtc-transport";
import type { SignalingChannel } from "@repo/webrtc-transport";
import type { AttemptPathFn, LocalQueue, ShardTransferRequest, TransferPath, TransferResult } from "@repo/transfer-manager";

import { getTrustedNodes } from "../trusted-nodes";
import { canAttemptLocalPath, canAttemptRelaySignaling, getWebRtcCapabilities } from "../local-network";
import type { ShardUpload, ShardUploadResult } from "../buffer";

export interface BrowserAttemptPathDeps {
  postShard: (dto: ShardUpload) => Promise<ShardUploadResult>;
  localQueue: LocalQueue;
  /** This browser's device id, used as the local-signaling session identity. */
  deviceId: string;
  sourceDevice?: string;
  /**
   * Relay-signaling channel factory (Path B). Optional: callers without a live
   * Relay WS client omit it, and Path B then throws so the chain falls to C.
   */
  createRelayChannel?: (targetNode: string) => SignalingChannel | null;
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
  });
}

export function createBrowserAttemptPath(deps: BrowserAttemptPathDeps): AttemptPathFn {
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
    let channel: SignalingChannel | null;
    if (path === "local_signaling") {
      if (!canAttemptLocalPath(caps)) throw new Error("local signaling unavailable in this browser context");
      channel = await resolveLocalChannel(request, deps);
    } else {
      if (!canAttemptRelaySignaling(caps)) throw new Error("WebRTC unavailable in this browser context");
      channel = deps.createRelayChannel?.(String(request.targetNode)) ?? null;
      if (!channel) throw new Error("relay signaling channel unavailable");
    }

    const transfer = await transferShardViaWebRtc({
      signalingChannel: channel,
      shard: {
        transferId: request.transferId,
        fileId: request.fileId,
        versionNumber: request.versionNumber,
        shardIndex: request.shardIndex,
        data: request.data,
        hash: request.hash,
        targetNode: request.targetNode,
        sourceDevice: deps.sourceDevice,
      },
      path: path === "local_signaling" ? "A" : "B",
    });
    return {
      path,
      durationMs: transfer.durationMs,
      transferId: request.transferId,
      bytesTransferred: transfer.bytesTransferred,
      success: true,
    };
  };
}
