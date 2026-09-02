import { hashShard } from "./crypto.js";
import type { EncryptedShard, ShardMetadata } from "./types.js";

/**
 * Construct `ShardMetadata` from an encrypted shard.
 *
 * This is the canonical way to produce finalized shard metadata in
 * `packages/core`. Callers should not duplicate this logic — the
 * protocol layer (`packages/protocol`) defines schema/types, while
 * this helper contains the domain logic for metadata construction.
 *
 * - `hash` is populated via `hashShard(encrypted.ciphertext)` and is
 *   guaranteed non-null in the returned metadata.
 * - `plaintextSize` must be provided by the caller (the value is known
 *   before encryption). It is NOT derived from ciphertext size, because
 *   AES-256-GCM ciphertext includes 16 bytes of authentication overhead.
 */
export function shardMetadataFromEncryptedShard(
  encrypted: EncryptedShard,
  plaintextSize: number,
): ShardMetadata {
  if (
    !Number.isInteger(plaintextSize) ||
    plaintextSize < 0
  ) {
    throw new Error(
      `shardMetadataFromEncryptedShard: plaintextSize must be a non-negative integer, got ${plaintextSize}`,
    );
  }

  return {
    fileId: encrypted.fileId,
    index: encrypted.index,
    size: plaintextSize,
    hash: hashShard(encrypted.ciphertext),
  };
}
