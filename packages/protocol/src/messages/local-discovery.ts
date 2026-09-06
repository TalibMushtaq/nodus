import { z } from "zod";
import { NodeId } from "../types.js";

// ── Local discovery (device ↔ node, HTTP only) ───────────────────────
//
// These schemas describe the JSON bodies exchanged over the Storage Node's
// local HTTP listener (`/nodus/*`). They are deliberately NOT registered in
// the WebSocket envelope dispatch (`envelope.ts`) — the local listener is a
// plain-HTTP trust boundary, not part of the Relay↔Node WS message catalog.

/**
 * Node's identity advertisement returned by `GET /nodus/discovery`.
 * Also carried in the structured non-mDNS fallback (manual IP entry) so a
 * client can verify the node it probed before opening further requests.
 * `pk_fp` is the first 8 bytes of a BLAKE3 hash of the public key,
 * hex-encoded — a cheap pre-check that matches the mDNS TXT record.
 */
export const LocalDiscoveryAdvertisementSchema = z.object({
  node_id: NodeId,
  /** Raw Ed25519 public key, hex-encoded */
  public_key: z.string(),
  /** Protocol schema version the node serves */
  schema_version: z.string(),
  /** Optional pk fingerprint, matches the mDNS TXT `pk_fp` value */
  pk_fp: z.string().optional(),
});

export type LocalDiscoveryAdvertisement = z.infer<
  typeof LocalDiscoveryAdvertisementSchema
>;

/**
 * Client → node: probe the local listener. Body is empty today; the type
 * exists so both sides can evolve the contract without a breaking shape
 * change to the endpoint.
 */
export const LocalDiscoveryPingSchema = z.object({
  client_id: z.string().optional(),
});

export type LocalDiscoveryPing = z.infer<typeof LocalDiscoveryPingSchema>;

/**
 * Node → client: reply to a ping. Carries the node identity so a client can
 * populate its discovery list without a second round trip.
 */
export const LocalDiscoveryPongSchema =
  LocalDiscoveryAdvertisementSchema.strict();

export type LocalDiscoveryPong = z.infer<typeof LocalDiscoveryPongSchema>;