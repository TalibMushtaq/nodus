import { z } from "zod";
import {
  DeviceId,
  NodeId,
  ProtocolFileId,
  TransferId,
} from "../types.js";

// ── Shard Upload ───────────────────────────────────────────────────

/**
 * Metadata for a shard being uploaded. The actual encrypted bytes travel on a
 * separate binary transport (WebRTC DataChannel binary frame or WebSocket binary
 * frame), NOT inline in this JSON payload. `transfer_id` ties this metadata
 * message to the binary transfer, which the transport layer validates
 * independently.
 *
 * This design avoids base64-encoding up to 8 MB of shard data inside JSON
 * (which would add ~33% overhead) and lets the binary transport handle
 * byte-level framing and checksums natively.
 */
export const ShardUploadPayloadSchema = z.object({
  file_id: ProtocolFileId,
  /** 0-based shard index within the file */
  shard_index: z.number().int().min(0),
  /** BLAKE3 hex digest of the encrypted ciphertext */
  hash: z.string(),
  /** Shard size in plaintext bytes */
  size: z.number().int().min(0),
  /** Ties this metadata to the separate binary transfer stream */
  transfer_id: TransferId,
  /** Node that should receive this shard */
  target_node: NodeId.optional(),
  /** Device that initiated the upload */
  source_device: DeviceId.optional(),
});

export type ShardUploadPayload = z.infer<typeof ShardUploadPayloadSchema>;

// ── Shard Ack ──────────────────────────────────────────────────────

/**
 * Acknowledgement of shard receipt or verification.
 * Ties into the file state machine in §23: NODE_RECEIVING → NODE_VERIFIED.
 */
export const ShardAckStatusSchema = z.enum(["received", "verified", "failed"]);
export type ShardAckStatus = z.infer<typeof ShardAckStatusSchema>;

export const ShardAckPayloadSchema = z.object({
  file_id: ProtocolFileId,
  shard_index: z.number().int().min(0),
  status: ShardAckStatusSchema,
  transfer_id: TransferId,
  /** Human-readable failure reason when status is "failed" */
  error_message: z.string().optional(),
});

export type ShardAckPayload = z.infer<typeof ShardAckPayloadSchema>;

// ── Pending Notify ─────────────────────────────────────────────────

/**
 * Relay → Node notification that a buffered shard is waiting for pickup
 * (Path C, §13 relay buffer lifecycle). Sent when a client uploads a shard
 * to the Relay buffer while the target Storage Node is offline.
 */
export const PendingNotifyPayloadSchema = z.object({
  file_id: ProtocolFileId,
  shard_index: z.number().int().min(0),
  /** Relay-assigned buffer identifier */
  buffer_id: z.string(),
  /** Device that uploaded the shard to the buffer */
  from_device: DeviceId,
  /** Hash for integrity verification when the node fetches the shard */
  hash: z.string(),
  size: z.number().int().min(0),
});

export type PendingNotifyPayload = z.infer<typeof PendingNotifyPayloadSchema>;

// ── Shard Fetch ────────────────────────────────────────────────────

/**
 * Request to retrieve a shard from a peer or the Relay buffer.
 */
export const ShardFetchPayloadSchema = z.object({
  file_id: ProtocolFileId,
  shard_index: z.number().int().min(0),
  transfer_id: TransferId,
  /** Where to fetch from — node or relay buffer */
  source: z.union([NodeId, z.literal("relay_buffer")]),
});

export type ShardFetchPayload = z.infer<typeof ShardFetchPayloadSchema>;

// ── Shard Delete ───────────────────────────────────────────────────

/**
 * Request to delete a shard (e.g. after successful transfer confirmation,
 * or as part of garbage collection §29a).
 */
export const ShardDeletePayloadSchema = z.object({
  file_id: ProtocolFileId,
  shard_index: z.number().int().min(0),
  /** Reason for deletion — informational only, not parsed by receivers */
  reason: z.string().optional(),
});

export type ShardDeletePayload = z.infer<typeof ShardDeletePayloadSchema>;
