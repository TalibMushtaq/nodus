"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { TransferManager } from "@repo/transfer-manager";
import type { ShardTransferRequest, TransferResult } from "@repo/transfer-manager";

import { postShard } from "../lib/buffer";
import type { WebRtcCapabilities } from "../lib/local-network";
import { useWebRtcCapabilities } from "../lib/use-capabilities";
import { createBrowserAttemptPath } from "../lib/transfer/attempt-path";
import { IndexedDBLocalQueue } from "../lib/transfer/local-queue";
import { IndexedDBPathCache } from "../lib/transfer/path-cache";
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
  const { status: wsStatus } = useWs();
  const [manager, setManager] = useState<TransferManager | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const queueRef = useRef<IndexedDBLocalQueue | null>(null);
  const capabilities = useWebRtcCapabilities();

  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    const cache = new IndexedDBPathCache();
    const queue = new IndexedDBLocalQueue();
    Promise.all([cache.hydrate(), queue.hydrate()]).then(() => {
      if (cancelled) return;
      const attemptPath = createBrowserAttemptPath({
        postShard,
        localQueue: queue,
        deviceId: device.device_id,
        sourceDevice: device.device_id,
      });
      queueRef.current = queue;
      setManager(new TransferManager(attemptPath, undefined, cache, queue));
      setQueuedCount(queue.size);
    });
    return () => {
      cancelled = true;
      queueRef.current = null;
    };
  }, [device]);

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
