"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { TransferManager } from "@repo/transfer-manager";
import type { ShardTransferRequest, TransferResult } from "@repo/transfer-manager";

import { postShard } from "../lib/buffer";
import { getWebRtcCapabilities } from "../lib/local-network";
import { createBrowserAttemptPath } from "../lib/transfer/attempt-path";
import { IndexedDBLocalQueue } from "../lib/transfer/local-queue";
import { IndexedDBPathCache } from "../lib/transfer/path-cache";
import { useAuth } from "./auth-provider";

interface TransferContextValue {
  /** Undefined until IndexedDB hydration + manager construction complete. */
  uploadShard: (request: ShardTransferRequest) => Promise<TransferResult>;
  queuedCount: number;
  capabilities: ReturnType<typeof getWebRtcCapabilities>;
}

const TransferContext = createContext<TransferContextValue | null>(null);

/**
 * Owns the browser Transfer Manager and its IndexedDB backends. Path C/D work
 * without any direct-peer capability; A/B are attempted first and fall through
 * when the environment cannot support them.
 */
export function TransferProvider({ children }: { children: ReactNode }) {
  const { device } = useAuth();
  const [manager, setManager] = useState<TransferManager | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const capabilities = useMemo(() => getWebRtcCapabilities(), []);

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
      setManager(new TransferManager(attemptPath, undefined, cache, queue));
      setQueuedCount(queue.size);
    });
    return () => {
      cancelled = true;
    };
  }, [device]);

  const value = useMemo<TransferContextValue>(
    () => ({
      uploadShard: async (request) => {
        if (!manager) throw new Error("transfer manager not ready");
        const result = await manager.uploadShard(request);
        setQueuedCount(manager.queuedCount);
        return result;
      },
      queuedCount,
      capabilities,
    }),
    [manager, queuedCount, capabilities],
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
