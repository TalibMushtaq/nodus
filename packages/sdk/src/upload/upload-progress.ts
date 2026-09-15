// Resumable upload progress record for Path C (shared by web and native).
//
// A `FILE_VERSION_ADDED` event asserts a shard_count; this record tracks which
// shard indices have actually reached at least RELAY_BUFFERED, so a retry or a
// resumed session re-sends only the outstanding shards. It also carries the
// version hash and encrypted name from pass 1 so a resume can re-emit events
// without re-reading the source. The platform owns persistence; this module
// only defines the record and its key.

export interface UploadProgress {
  /** `${fileId}:${versionNumber}` — the store's key. */
  transferId: string;
  fileId: string;
  versionNumber: number;
  targetNode: string;
  totalShards: number;
  /** BLAKE3 hex of the whole plaintext, from upload pass 1. */
  versionHash: string;
  /** FEK-encrypted filename (see @repo/core encryptName). */
  encryptedName: string;
  /**
   * Plaintext bytes per shard used for this upload. Persisted so a resume keeps
   * the original boundaries even if the user changes the shard-size preference.
   * Optional: records written before configurable shards lack it (8 MiB).
   */
  shardSizeBytes?: number;
  /** True once FILE_CREATED + FILE_VERSION_ADDED have been acknowledged. */
  announced: boolean;
  /** Shard indices confirmed RELAY_BUFFERED by a successful postShard. */
  completedShards: number[];
  /**
   * BLAKE3 hex of each uploaded packed shard, indexed by shard index. Persisted
   * so a resumed upload can still publish the signed per-shard manifest.
   * Optional: records written before the manifest feature lack it.
   */
  shardHashes?: string[];
  createdAt: string;
  updatedAt: string;
}

export function uploadKey(fileId: string, versionNumber: number): string {
  return `${fileId}:${versionNumber}`;
}
