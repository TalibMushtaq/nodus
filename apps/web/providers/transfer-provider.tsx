"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { TransferManager } from "@repo/transfer-manager";
import type { ShardTransferRequest, TransferResult } from "@repo/transfer-manager";

import { postShard } from "../lib/buffer";
import type { WebRtcCapabilities } from "../lib/local-network";
import { useWebRtcCapabilities } from "../lib/use-capabilities";
import { createBrowserAttemptPath } from "../lib/transfer/attempt-path";
import { createBrowserRelayChannel } from "../lib/transfer/relay-signaling";
import { WebRtcSessionCache } from "../lib/transfer/webrtc-session";
import { IndexedDBLocalQueue } from "../lib/transfer/local-queue";
import { IndexedDBPathCache } from "../lib/transfer/path-cache";
import { identityPrivateKey, signDeviceMessage } from "@repo/relay-client";
import { useAuth } from "./auth-provider";
import { useWs } from "./ws-provider";

interface TransferContextValue {
  /** Undefined until IndexedDB hydration + manager construction complete. */
  uploadShard: (request: ShardTransferRequest) => Promise<TransferResult>;
  /** True once the manager is hydrated and can run the fallback chain. */
  ready: boolean;
  /** Shards waiting for a path (Path D local queue), across all files. */
  queuedCount: number;
  /** True when a specific file still has shards queued for retry. */
  hasPending: (fileId: string) => boolean;
  /** Drain the local queue now (also runs automatically on reconnect). */
  retryPending: () => void;
  /** Null until capabilities resolve after mount (SSR-safe). */
  capabilities: WebRtcCapabilities | null;
}

const TransferContext = createContext<TransferContextValue | null>(null);

/**
 * Owns the browser Transfer Manager and its IndexedDB backends. Path C/D work
 * without any direct-peer capability; A/B are attempted first and fall through
 * when the environment cannot support them.
 *
 * Queued shards (Path D) are drained automatically whenever the relay socket
 * reaches `connected`, so a file uploaded while the relay/node were unavailable
 * is backed up without user action once they return.
 */
export function TransferProvider({ children }: { children: ReactNode }) {
  const { device } = useAuth();
  // `send`/`on` drive Path B: the browser's WebRTC offer and ICE trickle to the
  // node as `webrtc_*` envelopes over the same Relay socket the rest of the app
  // uses. Without this the relay_signaling path had no channel and every remote
  // upload fell through to the HTTP relay buffer.
  const { status: wsStatus, send: wsSend, on: wsOn } = useWs();
  const [manager, setManager] = useState<TransferManager | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const queueRef = useRef<IndexedDBLocalQueue | null>(null);
  const capabilities = useWebRtcCapabilities();

  // Path B signals through the Relay, so the attempt path needs the *current*
  // socket state without rebuilding the manager on every status transition.
  const wsStatusRef = useRef(wsStatus);
  useEffect(() => {
    wsStatusRef.current = wsStatus;
  }, [wsStatus]);

  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    const cache = new IndexedDBPathCache();
    const queue = new IndexedDBLocalQueue();
    // Persistent WebRTC sessions outlive individual shards; the provider owns
    // them so an unmount closes the peer connections and signaling sockets.
    const sessionCache = new WebRtcSessionCache();
    Promise.all([cache.hydrate(), queue.hydrate()]).then(() => {
      if (cancelled) return;
      const attemptPath = createBrowserAttemptPath({
        postShard,
        localQueue: queue,
        sessionCache,
        deviceId: device.device_id,
        sourceDevice: device.device_id,
        // Path A requires proving device identity to the node per message.
        signLocal: (message) => signDeviceMessage(identityPrivateKey(device), message),
        // Path B (internet WebRTC): signal through the Relay socket. Built per
        // attempt because each shard transfer needs its own signaling state;
        // it returns null when the socket is not up, which makes the executor
        // fall through to Path C.
        createRelayChannel: (targetNode) =>
          createBrowserRelayChannel({
            send: wsSend,
            on: wsOn,
            fromPeer: device.device_id,
            toPeer: targetNode,
            // Prove device identity so a compromised Relay cannot inject an
            // offer on this device's behalf.
            sign: (message) => signDeviceMessage(identityPrivateKey(device), message),
          }),
        // Skip Path B entirely while the Relay socket is down: it cannot signal,
        // and otherwise every shard would burn a negotiation timeout before
        // falling back to the buffer.
        isRelayAvailable: () => wsStatusRef.current === "connected",
      });
      queueRef.current = queue;
      setManager(new TransferManager(attemptPath, undefined, cache, queue));
      setQueuedCount(queue.size);
    });
    return () => {
      cancelled = true;
      queueRef.current = null;
      sessionCache.closeAll();
    };
  }, [device, wsSend, wsOn]);

  const syncQueued = useCallback(() => setQueuedCount(queueRef.current?.size ?? 0), []);

  // Auto-retry on reconnect. Draining is fire-and-forget, so re-read the queue
  // size on the next tick to reflect what actually left the queue.
  useEffect(() => {
    if (wsStatus !== "connected" || !manager) return;
    manager.notifyConnectivityRestored();
    const timer = setTimeout(syncQueued, 0);
    return () => clearTimeout(timer);
  }, [wsStatus, manager, syncQueued]);

  const value = useMemo<TransferContextValue>(
    () => ({
      uploadShard: async (request) => {
        if (!manager) throw new Error("transfer manager not ready");
        const result = await manager.uploadShard(request);
        syncQueued();
        return result;
      },
      ready: manager !== null,
      queuedCount,
      hasPending: (fileId: string) => queueRef.current?.hasFile(fileId) ?? false,
      retryPending: () => {
        manager?.notifyConnectivityRestored();
        syncQueued();
      },
      capabilities,
    }),
    [manager, queuedCount, syncQueued, capabilities],
  );

  return <TransferContext.Provider value={value}>{children}</TransferContext.Provider>;
}

export function useTransfer(): TransferContextValue {
  const ctx = useContext(TransferContext);
  if (!ctx) {
    throw new Error("useTransfer must be used within a TransferProvider");
  }
  return ctx;
}
