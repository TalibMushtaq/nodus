// Native Transfer Manager wiring.
//
// Builds the shared TransferManager over the mobile attempt-path chain
// (A → B → C → D) with SQLite-backed queue/path cache and a shared WebRTC
// session cache, so shards prefer a direct/local path and only fall back to the
// Relay buffer or the persistent queue when those are unavailable.

import { WebRtcSessionCache } from "@repo/sdk";
import { TransferManager } from "@repo/transfer-manager";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { SqliteLocalQueue } from "../store/local-queue";
import { SqlitePathCache } from "../store/path-cache";
import type { MobileWs } from "../ws";
import { createMobileAttemptPath } from "./attempt-path";

export interface MobileTransferManager {
  manager: TransferManager;
  localQueue: SqliteLocalQueue;
  sessionCache: WebRtcSessionCache;
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

  return {
    manager,
    localQueue,
    sessionCache,
    close: () => {
      sessionCache.closeAll();
    },
  };
}
