import { z } from "zod";
import { NodeId, SnapshotId } from "../types.js";

// ── Snapshot records ────────────────────────────────────────────────
//
// A snapshot is streamed as typed, homogeneous chunks. Each chunk carries one
// record type ('file_version' | 'tombstone') and an array of up to
// SNAPSHOT_CHUNK_MAX_RECORDS records. Keeping each chunk homogeneous (one
// record type) rather than interleaving types is simpler to validate and apply,
// at the cost of slightly more chunks for accounts with both file versions and
// tombstones.

/** Maximum number of records carried in a single snapshot chunk. */
export const SNAPSHOT_CHUNK_MAX_RECORDS = 1000;

/** Snapshot record type discriminants. */
export const SnapshotRecordTypeSchema = z.enum(["file_version", "tombstone"]);
export type SnapshotRecordType = z.infer<typeof SnapshotRecordTypeSchema>;

/**
 * A file/version row captured in a snapshot. Mirrors the Relay `file_versions`
 * projection plus the fields needed to reconstruct `files` (encrypted name and
 * parent folder) since the snapshot is the source of truth for a full rebuild.
 */
export const FileVersionRecordSchema = z.object({
  file_id: z.string(),
  version_number: z.number().int().min(1),
  parent_version_id: z.number().int().min(1).nullable().optional(),
  conflict_status: z.enum(["none", "flagged", "resolved"]).optional(),
  version_hash: z.string(),
  shard_count: z.number().int().min(1),
  encrypted_name: z.string().nullable().optional(),
  parent_folder_id: z.string().nullable().optional(),
});

export type FileVersionRecord = z.infer<typeof FileVersionRecordSchema>;

/**
 * A tombstone row captured in a snapshot. Only tombstones newer than the
 * retention window (90 days, ADR-0005) are required to appear in a fresh
 * snapshot; older ones may be omitted since they're already eligible for pruning.
 */
export const TombstoneRecordSchema = z.object({
  entity_type: z.enum(["file", "folder"]),
  entity_id: z.string(),
  deleted_at: z.string().datetime(),
});

export type TombstoneRecord = z.infer<typeof TombstoneRecordSchema>;

// ── Snapshot Begin ─────────────────────────────────────────────────

/**
 * Metadata for a full snapshot transfer (§20). Sent by the Rust node before
 * streaming snapshot chunks to the Relay. The Relay validates the signature
 * against the trusted (primary) node public key before accepting the snapshot.
 */
export const SnapshotBeginPayloadSchema = z.object({
  snapshot_id: SnapshotId,
  node_id: NodeId,
  /**
   * Monotonic per-node snapshot counter (snapshot #1, #2, ...). Its only job is
   * letting the Relay detect stale/duplicate rebuild attempts and log which
   * snapshot generation is live. It is NOT an origin_sequence.
   */
  snapshot_sequence: z.number().int().min(1),
  /** Number of chunks that will follow before snapshot_end */
  total_chunks: z.number().int().min(1),
  /** BLAKE3 content hash of the complete snapshot payload */
  content_hash: z.string(),
  /** Ed25519 signature over the content_hash, signed by the node's identity key */
  signature: z.string(),
  /** Schema version of the data inside the snapshot (may differ from message envelope version) */
  data_schema_version: z.string(),
  /**
   * Full per-origin cursor map so the Relay can repopulate sync_cursors after
   * promotion. Without this, Phase 8 incremental sync has no correct resume
   * point per device/node.
   */
  cursors: z.array(
    z.object({
      origin_id: z.string(),
      sequence: z.number().int().min(0),
    }),
  ),
});

export type SnapshotBeginPayload = z.infer<typeof SnapshotBeginPayloadSchema>;

// ── Snapshot Chunk ─────────────────────────────────────────────────

/**
 * Ordered, homogeneous chunk of snapshot records. Chunks are reassembled by
 * `chunk_index` order; retries use the same `chunk_index` for idempotency.
 * `records` holds at most SNAPSHOT_CHUNK_MAX_RECORDS entries all of the same
 * `record_type`.
 */
export const SnapshotChunkPayloadSchema = z.object({
  snapshot_id: SnapshotId,
  /** 0-based chunk index for reassembly order */
  chunk_index: z.number().int().min(0),
  /** Homogeneous record type for this chunk */
  record_type: SnapshotRecordTypeSchema,
  /** Records carried by this chunk (capped at SNAPSHOT_CHUNK_MAX_RECORDS) */
  records: z
    .array(z.union([FileVersionRecordSchema, TombstoneRecordSchema]))
    .max(SNAPSHOT_CHUNK_MAX_RECORDS),
});

export type SnapshotChunkPayload = z.infer<typeof SnapshotChunkPayloadSchema>;

// ── Snapshot End ───────────────────────────────────────────────────

/**
 * Completion marker. Sent after the last `snapshot_chunk`. The Relay
 * validates the final hash against the one promised in `snapshot_begin`
 * before promoting the rebuilt state.
 */
export const SnapshotEndPayloadSchema = z.object({
  snapshot_id: SnapshotId,
  /** BLAKE3 hash of all chunk data concatenated */
  final_hash: z.string(),
  /** Ed25519 signature over final_hash */
  signature: z.string(),
});

export type SnapshotEndPayload = z.infer<typeof SnapshotEndPayloadSchema>;
