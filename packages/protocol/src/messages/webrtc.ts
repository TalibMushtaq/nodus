import { z } from "zod";
import { DeviceId, NodeId } from "../types.js";

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
});

export type WebRTCIceCandidatePayload = z.infer<typeof WebRTCIceCandidatePayloadSchema>;
