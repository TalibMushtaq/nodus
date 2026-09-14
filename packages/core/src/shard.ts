import type { FileId, Shard, ShardIndex } from "./types.js";

/**
 * Default shard size in bytes (8 MiB).
 *
 * Shard size is a client choice, not a protocol constant: the node accepts any
 * shard up to its hard cap and downloads are size-agnostic (they fetch by index
 * and count). A larger shard means fewer transfers and less per-shard overhead;
 * a smaller one means a smaller retry unit. The relay's buffer/WS limits must
 * be raised (`MAX_SHARD_BYTES_MB`) for values above the default.
 */
export const DEFAULT_SHARD_SIZE_BYTES = 8 * 1024 * 1024;

/** Back-compat alias for the default. */
export const SHARD_SIZE_BYTES = DEFAULT_SHARD_SIZE_BYTES;

/** Smallest configurable shard size (1 MiB). */
export const MIN_SHARD_SIZE_BYTES = 1 * 1024 * 1024;

/** Largest configurable shard size (32 MiB). */
export const MAX_SHARD_SIZE_BYTES = 32 * 1024 * 1024;

/**
 * Clamp an arbitrary shard-size value into the supported range, falling back to
 * the default for a missing/invalid value. Used by callers that take the size
 * from a preference or an environment variable.
 */
export function resolveShardSize(bytes?: number | null): number {
  if (bytes == null || !Number.isFinite(bytes)) return DEFAULT_SHARD_SIZE_BYTES;
  return Math.min(MAX_SHARD_SIZE_BYTES, Math.max(MIN_SHARD_SIZE_BYTES, Math.floor(bytes)));
}

/**
 * Split `data` into shards of `shardSize` bytes (default `SHARD_SIZE_BYTES`).
 *
 * - Every shard except the last is exactly `shardSize`. The last shard is the
 *   remainder (or a full `shardSize` if the file divides evenly — no trailing
 *   empty shard is emitted in that case).
 * - A 0-byte input produces exactly one 0-byte shard. There is never a
 *   "file with zero shards" case.
 * - Shards are indexed 0-based, in order.
 *
 * Deliberate memory/perf choice: we use `.slice()` rather than
 * `.subarray()`. `.slice()` copies each shard out of the input, so the
 * original `data` buffer can be garbage collected as shards are emitted —
 * important for large files. `.subarray()` would be a zero-copy view but
 * would keep the entire input buffer alive for as long as any shard lives.
 */
export function splitIntoShards(
  fileId: FileId,
  data: Uint8Array,
  shardSize: number = SHARD_SIZE_BYTES,
): Shard[] {
  const shards: Shard[] = [];
  // A caller-supplied size is used as-is (tests exercise tiny shards); only a
  // missing/invalid value falls back to the default.
  const size = shardSize > 0 ? shardSize : SHARD_SIZE_BYTES;
  const count = Math.max(1, Math.ceil(data.length / size));

  for (let index = 0; index < count; index++) {
    const start = index * size;
    const end = Math.min(start + size, data.length);
    shards.push({
      fileId,
      index: index as ShardIndex,
      data: data.slice(start, end),
    });
  }

  return shards;
}

/**
 * Reconstruct the original file bytes from its shards.
 *
 * - Shards are sorted by `index` before concatenation; caller ordering is
 *   not assumed.
 * - A single 0-byte shard at index 0 reconstructs to a 0-byte `Uint8Array`.
 * - Throws on a genuine gap in the index sequence, duplicate indices, or an
 *   empty input array (an empty input has no way to prove the original was
 *   legitimately 0-byte — 0-byte files are always represented by one 0-byte
 *   shard, so empty input is always a caller error).
 * - Does NOT verify integrity. No hash check happens here — that is Phase 3,
 *   once `hash` is populated. Do not mistake reconstruction for a
 *   completeness guarantee.
 */
export function reconstructFromShards(shards: Shard[]): Uint8Array {
  if (shards.length === 0) {
    throw new Error(
      "reconstructFromShards: no shards provided. A 0-byte file is represented by one 0-byte shard, not an empty list.",
    );
  }

  const sorted = [...shards].sort((a, b) => a.index - b.index);
  const seen = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    const shard = sorted[i];
    if (shard === undefined) {
      throw new Error("reconstructFromShards: unexpected undefined shard");
    }

    if (seen.has(shard.index)) {
      throw new Error(
        `reconstructFromShards: duplicate shard index ${shard.index}`,
      );
    }
    seen.add(shard.index);

    if (shard.index !== i) {
      throw new Error(
        `reconstructFromShards: gap in shard index sequence — expected ${i}, got ${shard.index}`,
      );
    }
  }

  if (sorted.length === 1 && sorted[0]?.data.length === 0) {
    return new Uint8Array(0);
  }

  const total = sorted.reduce((sum, shard) => sum + shard.data.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const shard of sorted) {
    result.set(shard.data, offset);
    offset += shard.data.length;
  }
  return result;
}
