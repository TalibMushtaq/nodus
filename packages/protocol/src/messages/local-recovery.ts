import { z } from "zod";
import { DeviceId } from "../types.js";

// ── Offline recovery (device ↔ node, HTTP only, ADR-0002) ────────────
//
// The LAN counterpart of the Relay's recovery flow: prove the recovery phrase
// to a Storage Node, register the new device, and fetch the account's
// recovery-sealed envelopes so file/folder keys unlock with no Internet.
// Like the other /nodus/* bodies these are NOT in the WebSocket dispatch.

/**
 * Node → client: the recovery challenge from `POST /nodus/recovery/challenge`.
 * `recovery_public_key` is the account recovery Ed25519 key (base64) the node
 * found in its envelopes, so the client can check its phrase before spending
 * the nonce.
 */
export const LocalRecoveryChallengeSchema = z.object({
  nonce: z.string(),
  ttl_seconds: z.number().int().positive().optional(),
  account_id: z.string(),
  recovery_public_key: z.string(),
});
export type LocalRecoveryChallenge = z.infer<typeof LocalRecoveryChallengeSchema>;

/** Client → node: prove the phrase and register this device. */
export const LocalRecoveryRequestSchema = z.object({
  nonce: z.string(),
  /** Ed25519 signature over the nonce bytes by the recovery key, hex. */
  signature: z.string(),
  device_id: DeviceId,
  /** New device Ed25519 public key (base64). */
  device_public_key: z.string(),
});
export type LocalRecoveryRequest = z.infer<typeof LocalRecoveryRequestSchema>;

/** Node → client: outcome of `POST /nodus/recovery`. */
export const LocalRecoveryResultSchema = z.object({
  status: z.enum(["ok", "fail"]),
  account_id: z.string().optional(),
  device_id: z.string().optional(),
  message: z.string().optional(),
});
export type LocalRecoveryResult = z.infer<typeof LocalRecoveryResultSchema>;

/** A recovery-sealed file-key envelope returned by the node. */
export const LocalRecoveryFileEnvelopeSchema = z.object({
  file_id: z.string(),
  recipient_id: z.string(),
  recipient_kind: z.string(),
  encrypted_key: z.string(),
});
export type LocalRecoveryFileEnvelope = z.infer<typeof LocalRecoveryFileEnvelopeSchema>;

/** A recovery-sealed folder-key envelope returned by the node. */
export const LocalRecoveryFolderEnvelopeSchema = z.object({
  folder_id: z.string(),
  recipient_id: z.string(),
  recipient_kind: z.string(),
  encrypted_key: z.string(),
});
export type LocalRecoveryFolderEnvelope = z.infer<typeof LocalRecoveryFolderEnvelopeSchema>;

/** Node → client: `GET /nodus/recovery/envelopes` (signed device request). */
export const LocalRecoveryEnvelopesSchema = z.object({
  file_envelopes: z.array(LocalRecoveryFileEnvelopeSchema),
  folder_envelopes: z.array(LocalRecoveryFolderEnvelopeSchema),
});
export type LocalRecoveryEnvelopes = z.infer<typeof LocalRecoveryEnvelopesSchema>;
