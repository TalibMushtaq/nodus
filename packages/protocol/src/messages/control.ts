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
