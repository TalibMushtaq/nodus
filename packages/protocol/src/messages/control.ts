import { z } from "zod";
import { AccountId, DeviceId, NodeId } from "../types.js";

// ── Register ───────────────────────────────────────────────────────

/**
 * Capabilities a storage node advertises during registration.
 * The relay uses these to route transfer requests to nodes that can handle
 * them (e.g. only nodes with "storage" capability receive shard uploads).
 */
export const CapabilitySchema = z.enum(["storage", "signaling", "sync"]);
export type Capability = z.infer<typeof CapabilitySchema>;

/**
 * Device/node identity announcement to the Relay.
 * Sent once when a device or node first connects; the Relay uses this to
 * establish presence and verify the sender is authorized for the account.
 */
export const RegisterPayloadSchema = z.object({
  account_id: AccountId,
  device_id: DeviceId.optional(),
  node_id: NodeId.optional(),
  /** X25519 public key, hex-encoded */
  public_key: z.string(),
  capabilities: z.array(CapabilitySchema).default([]),
});

export type RegisterPayload = z.infer<typeof RegisterPayloadSchema>;

// ── Heartbeat ──────────────────────────────────────────────────────

/**
 * Liveness ping, minimal payload. Drives Relay-side presence (§13 Redis
 * presence). The Relay marks a node/device as absent if no heartbeat
 * arrives within a configured window.
 */
export const HeartbeatPayloadSchema = z.object({
  /** The node or device sending the heartbeat */
  id: z.union([AccountId, DeviceId, NodeId]),
  timestamp: z.string().datetime(),
});

export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

// ── Node Auth (Phase 8) ────────────────────────────────────────────

/**
 * Challenge sent from Relay to Node upon connection.
 * Nonce is an opaque cryptographically random value with a 30s TTL.
 */
export const NodeAuthChallengePayloadSchema = z.object({
  nonce: z.string(),
});

export type NodeAuthChallengePayload = z.infer<typeof NodeAuthChallengePayloadSchema>;

/**
 * Signature response from Node back to Relay.
 * Signed over the exact challenge nonce bytes using node's identity keypair.
 */
export const NodeAuthResponsePayloadSchema = z.object({
  node_id: NodeId,
  signature: z.string(),
});

export type NodeAuthResponsePayload = z.infer<typeof NodeAuthResponsePayloadSchema>;

/**
 * Result of the authentication handshake.
 */
export const NodeAuthResultPayloadSchema = z.object({
  status: z.enum(["ok", "fail"]),
  message: z.string().optional(),
});

export type NodeAuthResultPayload = z.infer<typeof NodeAuthResultPayloadSchema>;
