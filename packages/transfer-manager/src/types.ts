import type { NodeId } from "@repo/protocol";

/** Transfer path identifiers — the four methods in the fallback chain. */
export type TransferPath =
  | "local_signaling"
  | "relay_signaling"
  | "buffer_relay"
  | "local_queue";

/** Per-shard transfer state machine. */
export type TransferState =
  | "pending"
  | { state: "attempting"; path: TransferPath }
  | "succeeded"
  | "failed_permanent";

/** Full shard transfer request — describes one shard to send or receive. */
export interface ShardTransferRequest {
  transferId: string;
  fileId: string;
  versionNumber: number;
  shardIndex: number;
  data: Uint8Array;
  hash: string;
  targetNode: NodeId;
  sourceDevice?: string;
}

/** Outcome of a shard transfer. */
export interface TransferResult {
  path: TransferPath;
  durationMs: number;
  transferId: string;
  bytesTransferred: number;
  success: boolean;
  error?: string;
  /** Bytes actually received for a fetch. Empty for pushes and failed paths. */
  data?: Uint8Array;
  /** Content-hash the received bytes are expected to match (repair fetches). */
  objectId?: string;
}

/** Path cache entry. */
export interface PathCacheEntry {
  path: TransferPath;
  lastSuccessAt: number;
}

/** Generic path cache interface — swap implementations per platform. */
export interface PathCache {
  get(nodeId: string): PathCacheEntry | undefined;
  set(nodeId: string, path: TransferPath): void;
  evict(nodeId: string): void;
}

/** Queue item for Path D local persistent queue. */
export interface QueueItem {
  transferId: string;
  fileId: string;
  versionNumber: number;
  shardIndex: number;
  data: Uint8Array;
  hash: string;
  targetNode: NodeId;
  sourceDevice?: string;
  enqueuedAt: number;
  retryCount: number;
}

/**
 * Generic local queue interface — swap implementations per platform (Phase 14
 * provides `IndexedDBLocalQueue` for web, SQLite for mobile). The Transfer
 * Manager drains the queue on connectivity restoration and reports `size`,
 * so both are part of the contract.
 */
export interface LocalQueue {
  enqueue(item: QueueItem): void;
  dequeue(): QueueItem | undefined;
  peek(): QueueItem | undefined;
  remove(transferId: string): void;
  onConnectivityRestored(callback: () => void): void;
  /** Fire the registered connectivity-restored callbacks. */
  notifyConnectivityRestored(): void;
  readonly size: number;
}

/** Configuration for the transfer manager. */
export interface TransferConfig {
  /** Max concurrent shard transfers. */
  maxConcurrency: number;
  /** Timeout for local mDNS discovery (ms). */
  localDiscoveryTimeoutMs: number;
  /** Timeout for WebRTC negotiation (ms). */
  webrtcNegotiationTimeoutMs: number;
  /** Timeout for relay signaling round-trip (ms). */
  relaySignalingTimeoutMs: number;
  /** Base backoff delay (ms). */
  backoffBaseMs: number;
  /** Jitter range for backoff (ms). */
  backoffJitterMs: number;
  /** Max retries per stage before falling through. */
  maxRetriesPerStage: number;
}
