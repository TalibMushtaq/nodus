// FEK key envelopes (§25), shared by web and native.
//
// The uploading device holds each file's FEK (in its local key store). To let
// the account's other devices and the primary Storage Node read the file it
// seals the FEK for each recipient with the X25519 key derived from that
// recipient's Ed25519 identity (ADR-0001) and publishes the opaque envelope.
// The Relay stores it without ever seeing the FEK.
//
// Envelope encoding is self-describing JSON (v1) so the wire schema stays a
// single opaque string. This module is pure crypto/encoding plus a
// dependency-injected recipient collector; the platform owns fetching and
// persistence.

import {
  ed25519PrivateToX25519,
  ed25519PublicToX25519,
  openFekEnvelope,
  sealFekForRecipient,
} from "@repo/core";
import { EventTypes } from "@repo/protocol";
import type { EventPayload } from "@repo/protocol";

export type RecipientKind = "device" | "node" | "recovery";

export interface EnvelopeRecipient {
  recipientId: string;
  recipientKind: RecipientKind;
  /** Recipient Ed25519 public key (device or node identity). */
  edPublicKey: Uint8Array;
  /**
   * Recipient X25519 encryption key (ADR-0008), when the device has published
   * one. Sealing prefers this over deriving X25519 from `edPublicKey`.
   */
  x25519PublicKey?: Uint8Array;
}

export interface RelayEnvelope {
  file_id: string;
  recipient_id: string;
  recipient_kind: RecipientKind;
  encrypted_key: string;
}

/** A folder-key envelope as returned by the folder-envelope listing. */
export interface RelayFolderEnvelope {
  folder_id: string;
  recipient_id: string;
  recipient_kind: RecipientKind;
  encrypted_key: string;
}

/** One recipient's envelope coverage. */
export interface EnvelopeSummary {
  recipient_id: string;
  recipient_kind: RecipientKind;
  file_count: number;
  folder_count: number;
  /** ISO timestamp of the newest envelope for this recipient, or null. */
  last_updated: string | null;
}

/** Ciphertext-only backup of every envelope. */
export interface EnvelopeExport {
  account_id: string;
  generated_at: string;
  file_envelopes: RelayEnvelope[];
  folder_envelopes: RelayFolderEnvelope[];
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function fromHex(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Decode a recipient's Ed25519 public key from its catalogue encoding.
 *
 * The two catalogues do NOT share an encoding: devices register their key as
 * base64 (the client identity format), while Storage Nodes register it as
 * lowercase hex (the node redeem/enroll wire format). Decoding a 64-char hex
 * node key as base64 yields 48 bytes, which then makes the Ed25519→X25519
 * conversion throw the opaque `"point" expected Uint8Array of length 32`.
 * Validate the length here so a future encoding drift fails actionably.
 */
export function decodeRecipientPublicKey(encoded: string, kind: RecipientKind): Uint8Array {
  const bytes = kind === "node" ? fromHex(encoded) : fromBase64(encoded);
  if (bytes.length !== 32) {
    throw new Error(`${kind} public key must decode to 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

export function encodeEnvelope(envelope: {
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}): string {
  return JSON.stringify({
    v: 1,
    epk: toBase64(envelope.ephemeralPublicKey),
    n: toBase64(envelope.nonce),
    ct: toBase64(envelope.ciphertext),
  });
}

export function decodeEnvelope(encoded: string): {
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
} {
  let parsed: { v?: number; epk?: string; n?: string; ct?: string };
  try {
    parsed = JSON.parse(encoded) as typeof parsed;
  } catch {
    throw new Error("decodeEnvelope: unrecognized envelope encoding");
  }
  if (parsed.v !== 1 || !parsed.epk || !parsed.n || !parsed.ct) {
    throw new Error("decodeEnvelope: unrecognized envelope encoding");
  }
  return {
    ephemeralPublicKey: fromBase64(parsed.epk),
    nonce: fromBase64(parsed.n),
    ciphertext: fromBase64(parsed.ct),
  };
}

/** Seal a FEK for one recipient's Ed25519 identity public key. */
export function sealFekForRecipientIdentity(fek: Uint8Array, edPublicKey: Uint8Array): string {
  return encodeEnvelope(sealFekForRecipient(fek, ed25519PublicToX25519(edPublicKey)));
}

/** Seal a FEK for a recipient's published X25519 encryption key (ADR-0008). */
export function sealFekForEncryptionKey(fek: Uint8Array, x25519PublicKey: Uint8Array): string {
  return encodeEnvelope(sealFekForRecipient(fek, x25519PublicKey));
}

/** Seal a FEK for many recipients, ready to emit as KEY_ENVELOPE_ADDED events. */
export function sealFekForRecipients(
  fek: Uint8Array,
  recipients: EnvelopeRecipient[],
): { recipient_id: string; recipient_kind: RecipientKind; encrypted_key: string }[] {
  return recipients.map((r) => ({
    recipient_id: r.recipientId,
    recipient_kind: r.recipientKind,
    // Prefer a published X25519 key; fall back to the legacy Ed25519→X25519
    // derivation for recipients that have not published one (ADR-0008).
    encrypted_key: r.x25519PublicKey
      ? sealFekForEncryptionKey(fek, r.x25519PublicKey)
      : sealFekForRecipientIdentity(fek, r.edPublicKey),
  }));
}

/**
 * Open an envelope with an Ed25519 seed's derived X25519 key. Still used for
 * the account recovery identity, whose key comes from the recovery phrase
 * (ADR-0002); devices use `openFekFromEnvelopeX25519` instead.
 */
export function openFekFromEnvelope(encoded: string, edPrivateSeed: Uint8Array): Uint8Array {
  return openFekEnvelope(decodeEnvelope(encoded), ed25519PrivateToX25519(edPrivateSeed));
}

/** Open a device's envelope with its standalone X25519 private key (ADR-0008). */
export function openFekFromEnvelopeX25519(encoded: string, x25519PrivateKey: Uint8Array): Uint8Array {
  return openFekEnvelope(decodeEnvelope(encoded), x25519PrivateKey);
}

/**
 * Open this device's folder-key envelope from an already-fetched list with its
 * X25519 encryption key. Kept separate from fetching so the folder tree can
 * fetch once and open N envelopes without N round trips.
 */
export function openFolderKeyFromEnvelopes(
  envelopes: RelayFolderEnvelope[],
  folderId: string,
  deviceId: string,
  x25519PrivateKey: Uint8Array,
): Uint8Array | null {
  const mine = envelopes.find((e) => e.folder_id === folderId && e.recipient_id === deviceId);
  if (!mine) return null;
  return openFekFromEnvelopeX25519(mine.encrypted_key, x25519PrivateKey);
}

/**
 * Decode a device's published X25519 encryption key (base64). Length-checked so
 * a wrong encoding fails with a clear message rather than at seal time.
 */
export function decodeEncryptionPublicKey(encoded: string): Uint8Array {
  const bytes = fromBase64(encoded);
  if (bytes.length !== 32) {
    throw new Error(`encryption public key must decode to 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Minimal catalogue rows the recipient collector needs from the Relay. */
export interface EnvelopeDeviceInfo {
  device_id: string;
  public_key: string;
  status: string;
  /** Published X25519 encryption key (base64), when the device has one. */
  encryption_public_key?: string | null;
}

export interface EnvelopeNodeInfo {
  node_id: string;
  public_key: string;
  status: string;
}

export interface RecipientSources {
  listDevices(): Promise<EnvelopeDeviceInfo[]>;
  listNodes(): Promise<EnvelopeNodeInfo[]>;
}

/**
 * Every potential recipient for a file: this device plus all active devices,
 * the account's storage nodes, and — when enrolled — the account recovery
 * identity (ADR-0002), so a recovery phrase can later unlock the key.
 *
 * `recoveryPublicKey` is the account's recovery Ed25519 public key (base64),
 * read from the session. Its recipient_id is the key itself: the node and Relay
 * can both verify a signature against it without a separate id mapping.
 */
export async function collectRecipients(
  self: {
    deviceId: string;
    edPublicKey: Uint8Array;
    /**
     * This device's published standalone X25519 key (ADR-0008). Supplying it
     * makes the self-envelope seal to the same key the device opens with;
     * omitting it falls back to the Ed25519-derived key for old callers.
     */
    x25519PublicKey?: Uint8Array;
    recoveryPublicKey?: string | null;
  },
  sources: RecipientSources,
): Promise<EnvelopeRecipient[]> {
  const recipients: EnvelopeRecipient[] = [
    {
      recipientId: self.deviceId,
      recipientKind: "device",
      edPublicKey: self.edPublicKey,
      // Seal this device's own copy to its standalone X25519 key, matching the
      // opener. Without it the derived-key self-envelope cannot be reopened once
      // the local key cache is lost (the old fallback that masked this is gone).
      x25519PublicKey: self.x25519PublicKey,
    },
  ];

  // Recovery is a device-style base64 Ed25519 key (not a node's hex encoding).
  if (self.recoveryPublicKey) {
    recipients.push({
      recipientId: self.recoveryPublicKey,
      recipientKind: "recovery",
      edPublicKey: decodeRecipientPublicKey(self.recoveryPublicKey, "recovery"),
    });
  }

  const [devices, nodes] = await Promise.all([sources.listDevices(), sources.listNodes()]);
  for (const device of devices) {
    if (device.status !== "ACTIVE" || device.device_id === self.deviceId) continue;
    recipients.push({
      recipientId: device.device_id,
      recipientKind: "device",
      edPublicKey: decodeRecipientPublicKey(device.public_key, "device"),
      // Prefer the device's published X25519 key when it has one (ADR-0008);
      // devices that predate it keep the Ed25519-derived envelope key.
      x25519PublicKey: device.encryption_public_key
        ? decodeEncryptionPublicKey(device.encryption_public_key)
        : undefined,
    });
  }
  for (const node of nodes) {
    if (node.status !== "ACTIVE") continue;
    recipients.push({
      recipientId: node.node_id,
      recipientKind: "node",
      // Nodes report a hex key, not base64 — see decodeRecipientPublicKey.
      edPublicKey: decodeRecipientPublicKey(node.public_key, "node"),
    });
  }
  return recipients;
}

/** Build a KEY_ENVELOPE_ADDED event for one sealed envelope. */
export function envelopeEvent(
  originId: string,
  sequence: number,
  fileId: string,
  sealed: { recipient_id: string; recipient_kind: RecipientKind; encrypted_key: string },
): EventPayload {
  return {
    event_id: crypto.randomUUID() as EventPayload["event_id"],
    origin_id: originId,
    origin_sequence: sequence,
    type: EventTypes.KEY_ENVELOPE_ADDED,
    payload: {
      file_id: fileId,
      recipient_id: sealed.recipient_id,
      recipient_kind: sealed.recipient_kind,
      encrypted_key: sealed.encrypted_key,
    },
    timestamp: new Date().toISOString(),
  };
}

/** Build a FOLDER_KEY_ENVELOPE_ADDED event for one sealed folder key. */
export function folderEnvelopeEvent(
  originId: string,
  sequence: number,
  folderId: string,
  sealed: { recipient_id: string; recipient_kind: RecipientKind; encrypted_key: string },
): EventPayload {
  return {
    event_id: crypto.randomUUID() as EventPayload["event_id"],
    origin_id: originId,
    origin_sequence: sequence,
    type: EventTypes.FOLDER_KEY_ENVELOPE_ADDED,
    payload: {
      folder_id: folderId,
      recipient_id: sealed.recipient_id,
      recipient_kind: sealed.recipient_kind,
      encrypted_key: sealed.encrypted_key,
    },
    timestamp: new Date().toISOString(),
  };
}
