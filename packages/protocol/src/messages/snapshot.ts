import { z } from "zod";
import { NodeId, SnapshotId } from "../types.js";

// ── Snapshot Begin ─────────────────────────────────────────────────

/**
 * Metadata for a full snapshot transfer (§20). Sent by the Rust node before
 * streaming snapshot chunks to the Relay. The Relay validates the signature
 * against the trusted node public key before accepting the snapshot.
 */
export const SnapshotBeginPayloadSchema = z.object({
  snapshot_id: SnapshotId,
  node_id: NodeId,
  /** Sequence/checkpoint this snapshot represents */
  sequence: z.number().int().min(0),
  /** Number of chunks that will follow before snapshot_end */
  total_chunks: z.number().int().min(1),
  /** BLAKE3 content hash of the complete snapshot payload */
  content_hash: z.string(),
  /** Ed25519 signature over the content_hash, signed by the node's identity key */
  signature: z.string(),
  /** Schema version of the data inside the snapshot (may differ from message envelope version) */
  data_schema_version: z.string(),
});

export type SnapshotBeginPayload = z.infer<typeof SnapshotBeginPayloadSchema>;

// ── Snapshot Chunk ─────────────────────────────────────────────────

/**
 * Ordered chunk of snapshot data. Chunks are reassembled by `chunk_index`
 * order; retries use the same `chunk_index` for idempotency. The `data`
 * field carries opaque bytes (base64-encoded in JSON, or binary on a
 * separate transport depending on the implementation).
 */
export const SnapshotChunkPayloadSchema = z.object({
  snapshot_id: SnapshotId,
  /** 0-based chunk index for reassembly order */
  chunk_index: z.number().int().min(0),
  /** Chunk payload — base64-encoded or binary depending on transport */
  data: z.string(),
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
