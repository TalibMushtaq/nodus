/**
 * Phase 2 scope note:
 * Encryption and hashing are explicitly OUT OF SCOPE for this phase.
 * `Shard.data` and `ShardMetadata.hash` are plaintext/`null` here.
 * Phase 3 will fill in `hash` (BLAKE3) and introduce encryption on top of
 * the shapes defined below. Do not assume `Shard.data` is ciphertext.
 */

/** Opaque identifier for a logical file. Do not generate IDs in this package. */
export type FileId = string & { readonly __fileId: unique symbol };

/** 0-based position of a shard within a file's shard sequence. */
export type ShardIndex = number & { readonly __shardIndex: unique symbol };

/** A single shard: its data plus its position within the file. */
export interface Shard {
  readonly fileId: FileId;
  readonly index: ShardIndex;
  readonly data: Uint8Array;
}

/**
 * Metadata describing a single shard.
 *
 * - `size` is the shard's plaintext byte length.
 * - `hash` is unpopulated (`null`) in Phase 2. Phase 3 fills it with a
 *   BLAKE3 digest. It is typed `string | null` now so Phase 3 does not need
 *   a breaking type change.
 */
export interface ShardMetadata {
  readonly fileId: FileId;
  readonly index: ShardIndex;
  readonly size: number;
  readonly hash: string | null;
}
