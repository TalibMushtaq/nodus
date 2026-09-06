import { z } from "zod";
import { DeviceId } from "../types.js";

// ── Local authentication (device ↔ node, HTTP only) ──────────────────
//
// Like local-discovery, these are the HTTP bodies of the node's local
// challenge-response flow — NOT registered in the WebSocket envelope
// dispatch. The Relay↔Node auth (`node_auth_challenge` etc.) lives in
// `control.ts`; this module is the LAN-side proof of identity.

/**
 * Node → client: an authentication nonce from `POST /nodus/challenge`.
 * 32 cryptographically random bytes, hex-encoded. Single-use and 30s TTL
 * server-side (enforced independently of any client behavior).
 */
export const LocalChallengePayloadSchema = z.object({
  nonce: z.string(),
  /** Seconds until the nonce expires server-side. */
  ttl_seconds: z.number().int().positive().optional(),
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