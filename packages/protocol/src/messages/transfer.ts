import { z } from "zod";
import {
  DeviceId,
  NodeId,
  ProtocolFileId,
  TransferId,
} from "../types.js";

// ── Shard Upload ───────────────────────────────────────────────────

/**
 * Metadata for a shard being uploaded. The actual encrypted bytes travel over
 * HTTP (`POST /buffer/upload` for Path C relay buffering) or a separate binary
 * transport (WebRTC DataChannel binary frame), NOT inline in this JSON payload.
 * `transfer_id` ties this metadata to the binary transfer, which the transport
 * layer validates independently.
 *
 * This design avoids base64-encoding up to 8 MB of shard data inside JSON
 * (which would add ~33% overhead) and lets the binary transport handle
 * byte-level framing and checksums natively.
 */
export const ShardUploadPayloadSchema = z.object({
  file_id: ProtocolFileId,
  /** Monotonic version this shard belongs to — needed for file_locations PK */
  version_number: z.number().int().min(1),
  /** 0-based shard index within the file */
  shard_index: z.number().int().min(0),
  /** BLAKE3 hex digest of the encrypted ciphertext (the bytes being uploaded) */
  hash: z.string(),
  /** Encrypted payload size in bytes (the bytes on the wire, not plaintext) */
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
  /** Version this shard belongs to — lets Relay disambiguate in file_locations */
  version_number: z.number().int().min(1),
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
 * via `POST /buffer/upload` while the target Storage Node is offline.
 * The `fetch_token` lets the node fetch the shard bytes over HTTP without
 * needing its own auth middleware.
 */
export const PendingNotifyPayloadSchema = z.object({
  file_id: ProtocolFileId,
  /** Version this shard belongs to — needed for node to insert into shards table */
  version_number: z.number().int().min(1),
  shard_index: z.number().int().min(0),
  /** Relay-assigned buffer identifier */
  buffer_id: z.string(),
  /** Single-use token for GET /buffer/fetch (10-minute TTL, Redis GETDEL) */
  fetch_token: z.string(),
  /** Device that uploaded the shard to the buffer */
  from_device: DeviceId,
  /** BLAKE3 hex digest of the encrypted ciphertext — node verifies after fetch */
  hash: z.string(),
  /** Encrypted payload size in bytes — node verifies after fetch */
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

// ── Design A: shard stream framing ─────────────────────────────────

/**
 * Version byte of the Relay ↔ Node binary shard stream frame.
 *
 * Design A (a browser download the Relay serves by pulling the object from a
 * Storage Node) carries raw ciphertext as WebSocket **binary** frames, outside
 * the JSON envelope. Frames from several concurrent in-flight fetches can
 * interleave on the node's single Relay socket, so each frame must name the
 * request it belongs to. The previous scheme armed one request per *connection*,
 * which made concurrent fetches overwrite each other and starve until timeout;
 * tagging each frame by `request_id` is what makes concurrent serving safe.
 */
export const SHARD_FRAME_VERSION = 1;

/** Bytes of fixed header: 1 version + 2 big-endian request-id length. */
export const SHARD_FRAME_HEADER_BYTES = 3;

/** Largest request-id length the framing can address (`u16` length). */
export const SHARD_FRAME_MAX_REQUEST_ID_BYTES = 0xffff;

/**
 * Encode one streamed shard chunk: `[u8 version][u16be id_len][request_id][payload]`.
 *
 * `requestId` is ASCII (a UUID string in practice); the payload is the raw
 * ciphertext slice. Throws when the id is empty or does not fit the length
 * field, since a frame that cannot be routed would corrupt the stream.
 */
export function encodeShardFrame(requestId: string, payload: Uint8Array): Uint8Array {
  const idBytes = new TextEncoder().encode(requestId);
  if (idBytes.byteLength === 0 || idBytes.byteLength > SHARD_FRAME_MAX_REQUEST_ID_BYTES) {
    throw new Error(`shard frame request id must be 1..${SHARD_FRAME_MAX_REQUEST_ID_BYTES} bytes`);
  }
  const out = new Uint8Array(SHARD_FRAME_HEADER_BYTES + idBytes.byteLength + payload.byteLength);
  out[0] = SHARD_FRAME_VERSION;
  out[1] = (idBytes.byteLength >> 8) & 0xff;
  out[2] = idBytes.byteLength & 0xff;
  out.set(idBytes, SHARD_FRAME_HEADER_BYTES);
  out.set(payload, SHARD_FRAME_HEADER_BYTES + idBytes.byteLength);
  return out;
}

/**
 * Decode a streamed shard chunk. Returns `null` for a malformed frame (wrong
 * version byte, truncated header, or a length that overruns the buffer) so the
 * receiver can drop it rather than misroute bytes to a waiter.
 */
export function decodeShardFrame(
  frame: Uint8Array,
): { requestId: string; payload: Uint8Array } | null {
  if (frame.byteLength < SHARD_FRAME_HEADER_BYTES) return null;
  if (frame[0] !== SHARD_FRAME_VERSION) return null;
  const idLen = (frame[1]! << 8) | frame[2]!;
  const start = SHARD_FRAME_HEADER_BYTES;
  const end = start + idLen;
  if (idLen === 0 || end > frame.byteLength) return null;
  const requestId = new TextDecoder().decode(frame.subarray(start, end));
  return { requestId, payload: frame.subarray(end) };
}

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
