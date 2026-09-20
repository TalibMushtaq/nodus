import { z } from "zod";
import { DeviceId, NodeId, ProtocolFileId, TransferId } from "../types.js";

// ── Peer identifier ────────────────────────────────────────────────

/**
 * A peer is identified by either a device ID or a node ID.
 * WebRTC signaling messages (§5 Path B) carry `from`/`to` peer IDs so the
 * Relay can route SDP/ICE without inspecting payload contents.
 */
export const PeerIdSchema = z.union([DeviceId, NodeId]);
export type PeerId = z.infer<typeof PeerIdSchema>;

// ── WebRTC Offer ───────────────────────────────────────────────────

/**
 * SDP offer from one peer to another, routed through the Relay on Path B.
 * The SDP body is treated as an opaque string — we do not validate its
 * internal structure at the protocol layer.
 */
export const WebRTCOfferPayloadSchema = z.object({
  from_peer: PeerIdSchema,
  to_peer: PeerIdSchema,
  sdp: z.string(),
  /**
   * Unix-epoch milliseconds the offer was signed at. Required by the node for
   * relay-signaled (Path B) offers so it can enforce a freshness window; the
   * LAN path carries the timestamp in HTTP headers instead. Optional at the
   * schema layer so older/other senders remain valid, but the node rejects a
   * relay offer without it.
   */
  timestamp: z.number().int().optional(),
  /** Hex Ed25519 signature over `"{from_peer}:{session}:{timestamp}:{blake3(sdp)}"`. */
  signature: z.string().optional(),
});

export type WebRTCOfferPayload = z.infer<typeof WebRTCOfferPayloadSchema>;

// ── WebRTC Answer ──────────────────────────────────────────────────

/**
 * SDP answer responding to a `webrtc_offer`.
 */
export const WebRTCAnswerPayloadSchema = z.object({
  from_peer: PeerIdSchema,
  to_peer: PeerIdSchema,
  sdp: z.string(),
});

export type WebRTCAnswerPayload = z.infer<typeof WebRTCAnswerPayloadSchema>;

// ── ICE Candidate ──────────────────────────────────────────────────

/**
 * ICE candidate gathered during WebRTC negotiation.
 * The candidate string is opaque — the WebRTC stack handles parsing.
 */
export const WebRTCIceCandidatePayloadSchema = z.object({
  from_peer: PeerIdSchema,
  to_peer: PeerIdSchema,
  candidate: z.string(),
  /** Unix-epoch milliseconds the candidate was signed at (Path B only). */
  timestamp: z.number().int().optional(),
  /** Hex Ed25519 signature over `"{from_peer}:{session}:{timestamp}:{blake3(candidate)}"`. */
  signature: z.string().optional(),
});

export type WebRTCIceCandidatePayload = z.infer<typeof WebRTCIceCandidatePayloadSchema>;

// ── Node→node repair request ───────────────────────────────────────

/**
 * A repairing Storage Node asks a peer holder for an object over the Relay
 * (Path B). The holder replies with a signed `webrtc_offer` and streams the
 * shard directly over the resulting data channel. Routed by `from_peer`/
 * `to_peer` exactly like the other signaling messages; the Relay never sees the
 * shard bytes.
 */
export const NodeShardFetchPayloadSchema = z.object({
  from_peer: PeerIdSchema,
  to_peer: PeerIdSchema,
  /** The content-addressed object (BLAKE3 hex) being requested. */
  object_id: z.string(),
});

export type NodeShardFetchPayload = z.infer<typeof NodeShardFetchPayloadSchema>;

// ── Data-channel shard fetch (device pulls a stored shard from a node) ──
//
// The reverse of the upload frame protocol. A device opens a data channel to a
// Storage Node (the same offer/answer flow it uses to upload), sends a fetch
// request, and the node streams the stored ciphertext back:
//
//   request  : [text] { shard_fetch: true, ...file/version/shard/hash... }
//   response : [text] { shard_data: true, ...hash/size... }
//              [binary frames] ciphertext
//              [text] { shard_data_done: true }
//
// As with `shard_done`, the marker is an explicit boolean so the Rust node can
// parse it unambiguously and a crafted `file_id` can never be mistaken for a
// control frame. The request carries the BLAKE3 `hash` the node serves by; the
// client re-verifies the returned bytes itself, so no ack round-trip is needed.

export const ShardFetchRequestPayloadSchema = z.object({
  shard_fetch: z.literal(true),
  file_id: ProtocolFileId,
  version_number: z.number().int().min(1),
  shard_index: z.number().int().min(0),
  /** BLAKE3 hex of the stored ciphertext object being requested. */
  hash: z.string(),
  /** Declared ciphertext size, so the node can reject an implausible request. */
  size: z.number().int().min(0),
  transfer_id: TransferId,
  /** Node the device expects to serve the shard. */
  source_node: NodeId.optional(),
});

export type ShardFetchRequestPayload = z.infer<typeof ShardFetchRequestPayloadSchema>;

export const ShardDataHeaderSchema = z.object({
  shard_data: z.literal(true),
  /** BLAKE3 hex of the ciphertext that follows in the binary frames. */
  hash: z.string(),
  size: z.number().int().min(0),
  transfer_id: TransferId,
});

export type ShardDataHeader = z.infer<typeof ShardDataHeaderSchema>;
