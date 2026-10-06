import { z } from "zod";
import { DeviceId } from "../types.js";

// ── Local authentication (device ↔ node, HTTP only) ──────────────────
//
// Like local-discovery, these are the HTTP bodies of the node's local
// challenge-response flow — NOT registered in the WebSocket envelope
// dispatch. The Relay↔Node auth (`node_auth_challenge` etc.) lives in
// `control.ts`; this module is the LAN-side proof of identity.

/**
 * Domain-separation prefix for the node's Ed25519 signature over a local auth
 * challenge. Binding the purpose into the signed bytes means this signature
 * can never be replayed as a Relay WS auth proof (or vice versa). Both the
 * Rust node and the TS client build the message from this exact format.
 */
export const LOCAL_NODE_AUTH_PREFIX = "nodus-local-auth:";

/** Exact UTF-8 message a node signs to prove possession of its key. */
export function localNodeAuthMessage(nonce: string): string {
  return `${LOCAL_NODE_AUTH_PREFIX}${nonce}`;
}

/**
 * Domain-separation prefix for the node's signature over a WebRTC SDP answer
 * served on `/nodus/webrtc/offer`. Binding the session id + SDP means an
 * on-path attacker cannot swap the answer body (the DTLS fingerprint lives in
 * the SDP), nor replay it into another session.
 */
export const LOCAL_WEBRTC_ANSWER_PREFIX = "nodus-webrtc-answer:";

/** Exact UTF-8 message a node signs when answering a local WebRTC offer. */
export function localWebRtcAnswerMessage(sessionId: string, sdp: string): string {
  return `${LOCAL_WEBRTC_ANSWER_PREFIX}${sessionId}:${sdp}`;
}

/**
 * Node → client: an authentication nonce from `POST /nodus/challenge`.
 * 32 cryptographically random bytes, hex-encoded. Single-use and 30s TTL
 * server-side (enforced independently of any client behavior).
 *
 * The challenge also carries the node's identity and a signature over
 * [`localNodeAuthMessage`]. This is the only point where the node proves it
 * *is* the node (the `/nodus/auth` exchange only proves the device), so the
 * client verifies it against the pinned node public key before signing the
 * nonce with its own key. The fields are optional so an older node that omits
 * them still parses; callers that require node authentication reject a
 * challenge without them.
 */
export const LocalChallengePayloadSchema = z.object({
  nonce: z.string(),
  /** Seconds until the nonce expires server-side. */
  ttl_seconds: z.number().int().positive().optional(),
  /** Node id (hex of the node's Ed25519 public key). */
  node_id: z.string().optional(),
  /** Node Ed25519 public key, hex-encoded. */
  public_key: z.string().optional(),
  /** Ed25519 signature over `localNodeAuthMessage(nonce)`, hex-encoded. */
  node_signature: z.string().optional(),
});

export type LocalChallengePayload = z.infer<typeof LocalChallengePayloadSchema>;

/**
 * Client → node: proof of identity for `POST /nodus/auth`.
 * The client signs the exact challenge nonce bytes with its Ed25519
 * key; `nonce` carries back which challenge was issued so the node's
 * single-use store can be consulted unambiguously (mirrors the Relay↔Node
 * `node_auth_response` flow in `control.ts`).
 */
export const LocalChallengeResponsePayloadSchema = z.object({
  device_id: DeviceId,
  /** The nonce the client was issued; single-use server-side */
  nonce: z.string(),
  /** Ed25519 signature over the nonce bytes, hex-encoded */
  signature: z.string(),
});

export type LocalChallengeResponsePayload = z.infer<
  typeof LocalChallengeResponsePayloadSchema
>;

/**
 * Node → client: outcome of `POST /nodus/auth`.
 * `ok` machines use `status`; `fail` optionally carries a human-readable
 * reason for the client UI.
 */
export const LocalAuthResultPayloadSchema = z.object({
  status: z.enum(["ok", "fail"]),
  message: z.string().optional(),
  /** Echoed node identity so the client can confirm who it authenticated to */
  node_id: z.string().optional(),
});

export type LocalAuthResultPayload = z.infer<typeof LocalAuthResultPayloadSchema>;