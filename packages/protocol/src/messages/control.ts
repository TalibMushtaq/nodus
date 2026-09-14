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
 * Disk figures a Storage Node includes in its heartbeat so the Relay can show
 * "used of total" on the Overview without a direct browser→node connection
 * (nodes are usually unreachable from the browser behind NAT). Optional and
 * omitted by client devices, so older nodes keep heartbeating unchanged.
 */
export const NodeStorageStatsSchema = z.object({
  /** Bytes currently occupied on the node's storage volume. */
  used_bytes: z.number().int().nonnegative(),
  /** Total capacity of that volume, or 0 when the node cannot determine it. */
  total_bytes: z.number().int().nonnegative(),
});

export type NodeStorageStats = z.infer<typeof NodeStorageStatsSchema>;

/**
 * Liveness ping, minimal payload. Drives Relay-side presence (§13 Redis
 * presence). The Relay marks a node/device as absent if no heartbeat
 * arrives within a configured window.
 */
export const HeartbeatPayloadSchema = z.object({
  /** The node or device sending the heartbeat */
  id: z.union([AccountId, DeviceId, NodeId]),
  timestamp: z.string().datetime(),
  /** Present only for storage nodes; absent for client devices. */
  storage: NodeStorageStatsSchema.optional(),
});

export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

// ── Ping / Pong ────────────────────────────────────────────────────

/**
 * Manual reachability probe (the Devices page "Ping" action). The Relay sends a
 * `ping` to a connected node or device; the target immediately echoes a `pong`
 * with the same `id`, letting the Relay measure a real round trip rather than
 * inferring liveness from an open socket. Both directions carry only the
 * correlation id — no account or peer data.
 */
export const PingPayloadSchema = z.object({
  /** Correlation id echoed back in the matching pong. */
  id: z.string(),
});

export type PingPayload = z.infer<typeof PingPayloadSchema>;

export const PongPayloadSchema = z.object({
  id: z.string(),
});

export type PongPayload = z.infer<typeof PongPayloadSchema>;

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
 * Result of the authentication handshake. `message` is a human-readable
 * string; `reason` is a machine-readable code the Storage Node can act on
 * (e.g. surfaces "not paired, run `nodus node pair`" instead of retrying).
 */
export const NodeAuthResultPayloadSchema = z.object({
  status: z.enum(["ok", "fail"]),
  message: z.string().optional(),
  reason: z.enum(["node_not_found", "node_inactive"]).optional(),
});

export type NodeAuthResultPayload = z.infer<typeof NodeAuthResultPayloadSchema>;
