// FEK key envelopes for the web client (§25, Phase 14 F2).
//
// The uploading device holds each file's FEK (lib/keys.ts). To let the account's
// other devices and the primary Storage Node read the file it seals the FEK for
// each recipient with the X25519 key derived from that recipient's Ed25519
// identity (ADR-0001), and publishes the opaque envelope. The Relay stores it
// without ever seeing the FEK.
//
// Envelope encoding is self-describing JSON (v1) so the wire schema stays a
// single opaque string.

import {
  ed25519PrivateToX25519,
  ed25519PublicToX25519,
  openFekEnvelope,
  sealFekForRecipient,
} from "@repo/core";
import { EventTypes } from "@repo/protocol";
import type { EventPayload } from "@repo/protocol";

import { listDevices, listNodes } from "./pairing";

export type RecipientKind = "device" | "node";

export interface EnvelopeRecipient {
  recipientId: string;
  recipientKind: RecipientKind;
  /** Recipient Ed25519 public key (device or node identity). */
  edPublicKey: Uint8Array;
}

export interface RelayEnvelope {
  file_id: string;
  recipient_id: string;
  recipient_kind: RecipientKind;
  encrypted_key: string;
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
 * Decode a recipient's Ed25519 public key from its Relay catalogue encoding.
 *
 * The two catalogues do NOT share an encoding: devices register their key as
 * base64 (the client identity format), while Storage Nodes register it as
 * lowercase hex (the node redeem/enroll wire format, see Relay
 * `pairing_code.go`). Decoding a 64-char hex node key as base64 yields 48 bytes,
 * which then makes the Ed25519→X25519 conversion throw the opaque
 * `"point" expected Uint8Array of length 32, got length=48`. Validate the length
 * here so a future encoding drift fails with an actionable message.
 */
function decodeRecipientPublicKey(encoded: string, kind: RecipientKind): Uint8Array {
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

/** Seal a FEK for many recipients, ready to emit as KEY_ENVELOPE_ADDED events. */
export function sealFekForRecipients(
  fek: Uint8Array,
  recipients: EnvelopeRecipient[],
): { recipient_id: string; recipient_kind: RecipientKind; encrypted_key: string }[] {
  return recipients.map((r) => ({
    recipient_id: r.recipientId,
    recipient_kind: r.recipientKind,
    encrypted_key: sealFekForRecipientIdentity(fek, r.edPublicKey),
  }));
}

/** Open this device's envelope with its Ed25519 private seed. */
export function openFekFromEnvelope(encoded: string, edPrivateSeed: Uint8Array): Uint8Array {
  return openFekEnvelope(decodeEnvelope(encoded), ed25519PrivateToX25519(edPrivateSeed));
}

export async function fetchEnvelopes(fileId: string): Promise<RelayEnvelope[]> {
  const res = await fetch(`/api/envelopes?file_id=${encodeURIComponent(fileId)}`);
  if (!res.ok) {
    throw new Error(`failed to load envelopes: ${res.status}`);
  }
  return (await res.json()) as RelayEnvelope[];
}

/**
 * Fetch this device's envelope for a file and open it. Returns null when no
 * envelope exists for this device (e.g. the file was uploaded before F2).
 */
export async function fetchAndOpenFileKey(
  fileId: string,
  deviceId: string,
  edPrivateSeed: Uint8Array,
): Promise<Uint8Array | null> {
  const envelopes = await fetchEnvelopes(fileId);
  const mine = envelopes.find((e) => e.recipient_id === deviceId);
  if (!mine) return null;
  return openFekFromEnvelope(mine.encrypted_key, edPrivateSeed);
}

/**
 * Every potential recipient for a file: this device plus all active devices and
 * the account's storage nodes. `baseUrl` is injectable for non-browser callers.
 */
export async function collectRecipients(
  self: { deviceId: string; edPublicKey: Uint8Array },
  baseUrl = "",
): Promise<EnvelopeRecipient[]> {
  void baseUrl;

  const recipients: EnvelopeRecipient[] = [
    { recipientId: self.deviceId, recipientKind: "device", edPublicKey: self.edPublicKey },
  ];

  const [devices, nodes] = await Promise.all([listDevices(), listNodes()]);
  for (const device of devices) {
    if (device.status !== "ACTIVE" || device.device_id === self.deviceId) continue;
    recipients.push({
      recipientId: device.device_id,
      recipientKind: "device",
      edPublicKey: decodeRecipientPublicKey(device.public_key, "device"),
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
