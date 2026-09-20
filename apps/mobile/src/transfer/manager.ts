// Native Transfer Manager wiring.
//
// Builds the shared TransferManager over the mobile attempt-path chain
// (A → B → C → D) with SQLite-backed queue/path cache and a shared WebRTC
// session cache, so shards prefer a direct/local path and only fall back to the
// Relay buffer or the persistent queue when those are unavailable.

import { createSignedRelayChannel, WebRtcSessionCache } from "@repo/sdk";
import { TransferManager } from "@repo/transfer-manager";
import { NODUS_LOCAL_PORT, identityPrivateKey, signDeviceMessage, type StoredDeviceIdentity } from "@repo/relay-client";
import { createLocalSignalingChannel } from "@repo/webrtc-transport";

import { SqliteLocalQueue } from "../store/local-queue";
import { SqlitePathCache } from "../store/path-cache";
import { getTrustedNodes } from "../store/trusted-nodes";
import type { MobileWs } from "../ws";
import { createMobileAttemptPath } from "./attempt-path";
import { createNativePeerConnectionFactory } from "./webrtc";

/** One stored shard to pull directly from a node over WebRTC. */
export interface MobileShardFetchArgs {
  fileId: string;
  versionNumber: number;
  shardIndex: number;
  hash: string;
  size: number;
  nodeId: string;
  /** Cumulative bytes received for this shard, as chunks arrive. */
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
}

export interface MobileTransferManager {
  manager: TransferManager;
  localQueue: SqliteLocalQueue;
  sessionCache: WebRtcSessionCache;
  /**
   * Download counterpart of the upload chain: pull a stored shard over a
   * persistent data channel (LAN-preferred, relay-signaling fallback). Throws
   * when no direct path applies so the caller falls back to LAN HTTP/Relay.
   */
  downloadShardViaWebRtc: (args: MobileShardFetchArgs) => Promise<Uint8Array>;
  /** Tear down sessions/caches; call on sign-out. */
  close: () => void;
}

export interface MobileTransferManagerOptions {
  /**
   * Whether local (Path A) transfers may run. ADR-0004 keeps discovery and
   * direct LAN transfer foreground-only, so the app passes an AppState-backed
   * predicate; when it is false the chain skips straight to Path B/C/D.
   */
  canAttemptLocal?: () => boolean;
  /**
   * Node reachability from the Relay catalog; lets the chain skip WebRTC to a
   * node known offline and reach the Relay buffer immediately. Unknown nodes
   * should report online so a stale catalog does not disable direct transfers.
   */
  isNodeOnline?: (targetNode: string) => boolean;
}

/**
 * Create and hydrate a transfer manager for `device`. Hydration loads the
 * persisted path cache and deferred queue before the manager is used, so a
 * cold start does not lose queued shards.
 */
export async function createMobileTransferManager(
  device: StoredDeviceIdentity,
  ws: MobileWs,
  options: MobileTransferManagerOptions = {},
): Promise<MobileTransferManager> {
  const localQueue = new SqliteLocalQueue();
  const pathCache = new SqlitePathCache();
  const sessionCache = new WebRtcSessionCache();

  await Promise.all([localQueue.hydrate(), pathCache.hydrate()]);

  const attemptPath = createMobileAttemptPath({
    device,
    localQueue,
    relay: {
      send: (type, payload) => ws.send(type, payload),
      on: (type, handler) => ws.on(type, handler),
      isConnected: () => ws.isConnected,
    },
    sessionCache,
    canAttemptLocal: options.canAttemptLocal,
    isNodeOnline: options.isNodeOnline,
  });

  const manager = new TransferManager(attemptPath, undefined, pathCache, localQueue);

  const sign = (message: string) => signDeviceMessage(identityPrivateKey(device), message);
  const peerConnectionFactory = createNativePeerConnectionFactory();
  const localAllowed = () => options.canAttemptLocal?.() ?? true;

  const downloadShardViaWebRtc = async (args: MobileShardFetchArgs): Promise<Uint8Array> => {
    // Separate session key from uploads so a pull never queues behind an
    // in-flight upload's frame tail on the same channel.
    const key = `download:${args.nodeId}`;
    if (!sessionCache.isAvailable(key)) throw new Error("WebRTC session recently failed");

    const host = (await getTrustedNodes()).find((node) => node.node_id === args.nodeId)?.host ?? null;
    const useLocal = Boolean(host) && localAllowed();
    const useRelay = !useLocal && ws.isConnected;
    if (!useLocal && !useRelay) throw new Error("no direct path to node");

    const session = sessionCache.get(key, () => ({
      createChannel: () => {
        if (useLocal && host) {
          return createLocalSignalingChannel({
            baseUrl: `http://${host}:${NODUS_LOCAL_PORT}`,
            deviceId: device.device_id,
            sign,
          });
        }
        const channel = createSignedRelayChannel({
          send: (msg) => ws.send(msg.type, msg.payload),
          on: (type, handler) => ws.on(type, handler),
          fromPeer: device.device_id,
          toPeer: args.nodeId,
          sign,
        });
        if (!channel) throw new Error("relay signaling channel unavailable");
        return channel;
      },
      peerConnectionFactory,
      negotiationTimeoutMs: 8000,
    }));

    try {
      const result = await session.receive({
        transferId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        fileId: args.fileId,
        versionNumber: args.versionNumber,
        shardIndex: args.shardIndex,
        hash: args.hash,
        size: args.size,
        sourceNode: args.nodeId,
        onProgress: args.onProgress,
      });
      return result.data;
    } catch (err) {
      // Bench the node's direct path briefly so remaining shards skip it.
      sessionCache.markUnavailable(key);
      sessionCache.evict(key);
      throw err;
    }
  };

  return {
    manager,
    localQueue,
    sessionCache,
    downloadShardViaWebRtc,
    close: () => {
      sessionCache.closeAll();
    },
  };
}
