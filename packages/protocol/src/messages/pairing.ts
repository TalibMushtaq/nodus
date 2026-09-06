import { z } from "zod";
import { DeviceId, NodeId } from "../types.js";

// ── Pairing (Phase 11) ────────────────────────────────────────────────
//
// Transport split:
// - `PairingRequest` / `PairingConfirm` / `PairingReject` are the HTTP
//   bodies of the device ↔ node `/nodus/pair` flow (not WS messages).
// - `PairingTokenPush` IS a WebSocket message: it travels over the existing
//   Relay ↔ Storage Node WS connection when the Relay issues a token, so it
//   is the ONLY type in this module registered in `envelope.ts`.

/**
 * Device → node at `POST /nodus/pair`. Presents the Relay-issued token plus
 * the same pubkey it was bound to at issuance. The node redeems it locally
 * (fast path) or via the Relay verify endpoint (fallback), then records the
 * device as trusted.
 */
export const PairingRequestPayloadSchema = z.object({
  node_id: NodeId,
  /** The Relay-issued, device-bound, single-use token */
  token: z.string(),
  /** Raw Ed25519 public key of the pairing device, base64-encoded
   *  (matches the `pubkey` encoding in the `nodus://pair` QR URL) */
  device_public_key: z.string(),
  device_id: DeviceId.optional(),
});

export type PairingRequestPayload = z.infer<typeof PairingRequestPayloadSchema>;

/**
 * Node → device: pairing succeeded. Carries the account binding so the client
 * can store which account/node combination it paired under.
 */
export const PairingConfirmPayloadSchema = z.object({
  node_id: NodeId,
  /** Account id the node claims — informational for the client UI */
  account_id: z.string().optional(),
  device_id: DeviceId.optional(),
  /** The device key that was recorded as trusted */
  device_public_key: z.string().optional(),
});

export type PairingConfirmPayload = z.infer<typeof PairingConfirmPayloadSchema>;

/**
 * Node → device: pairing rejected. `reason` is a stable machine-readable code
 * (`token_expired` | `token_consumed` | `token_unknown` | `device_mismatch` |
 * `node_offline`) plus a message for the UI.
 */
export const PairingRejectPayloadSchema = z.object({
  node_id: NodeId.optional(),
  reason: z.enum([
    "token_expired",
    "token_consumed",
    "token_unknown",
    "device_mismatch",
    "node_offline",
  ]),
  message: z.string().optional(),
});

export type PairingRejectPayload = z.infer<typeof PairingRejectPayloadSchema>;

/**
 * Relay → Storage Node (over WS). Delivered immediately when the Relay issues
 * a pairing token, so the node's `/nodus/pair` handler can redeem it locally
 * without a round trip to the Relay. `device_public_key` is the pubkey the
 * token was bound to; `expires_at` mirrors the Relay row's TTL.
 */
export const PairingTokenPushPayloadSchema = z.object({
  node_id: NodeId,
  token: z.string(),
  device_public_key: z.string(),
  expires_at: z.string().datetime(),
});

export type PairingTokenPushPayload = z.infer<typeof PairingTokenPushPayloadSchema>;