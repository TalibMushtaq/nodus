// Web binding for the shared @repo/sdk FEK envelopes (§25).
//
// The sealing/opening crypto, encoding, recipient collection and event builders
// live in the SDK; this file adds the browser's transport (the Next BFF proxies
// under /api/envelopes*) and binds the recipient sources to the web catalogue.

import { collectRecipients as sdkCollectRecipients } from "@repo/sdk";
import {
  decodeRecipientPublicKey,
  decodeEnvelope,
  encodeEnvelope,
  envelopeEvent,
  folderEnvelopeEvent,
  encryptionPrivateKeyBytes,
  encryptionPublicKeyBytes,
  // Legacy Ed25519-seed opener: the e2e harness identity is Ed25519-only and
  // opens the envelopes its uploader sealed with sealFekForRecipientIdentity.
  openFekFromEnvelope,
  openFekFromEnvelopeX25519,
  openFolderKeyFromEnvelopes as sdkOpenFolderKeyFromEnvelopes,
  sealFekForRecipientIdentity,
  sealFekForRecipients,
} from "@repo/sdk";
import type {
  EnvelopeExport,
  EnvelopeRecipient,
  EnvelopeSummary,
  RelayEnvelope,
  RelayFolderEnvelope,
} from "@repo/sdk";

import { getOrCreateEncryptionIdentity } from "./device";
import { listDevices, listNodes } from "./pairing";

export {
  decodeRecipientPublicKey,
  decodeEnvelope,
  encodeEnvelope,
  envelopeEvent,
  folderEnvelopeEvent,
  encryptionPublicKeyBytes,
  openFekFromEnvelope,
  openFekFromEnvelopeX25519,
  sealFekForRecipientIdentity,
  sealFekForRecipients,
};
export type {
  RecipientKind,
  EnvelopeRecipient,
  RelayEnvelope,
  RelayFolderEnvelope,
  EnvelopeSummary,
  EnvelopeExport,
} from "@repo/sdk";

/** Per-recipient coverage for the Security page's Key envelopes table. */
export async function fetchEnvelopeSummary(): Promise<EnvelopeSummary[]> {
  const res = await fetch("/api/envelopes/summary");
  if (!res.ok) {
    throw new Error(`failed to load envelope summary: ${res.status}`);
  }
  return (await res.json()) as EnvelopeSummary[];
}

/** Download the account's opaque envelopes for offline safekeeping. */
export async function exportEnvelopes(): Promise<EnvelopeExport> {
  const res = await fetch("/api/envelopes/export");
  if (!res.ok) {
    throw new Error(`failed to export envelopes: ${res.status}`);
  }
  return (await res.json()) as EnvelopeExport;
}

export async function fetchEnvelopes(fileId: string): Promise<RelayEnvelope[]> {
  const res = await fetch(`/api/envelopes?file_id=${encodeURIComponent(fileId)}`);
  if (!res.ok) {
    throw new Error(`failed to load envelopes: ${res.status}`);
  }
  return (await res.json()) as RelayEnvelope[];
}

/**
 * Fetch every folder-key envelope for the account in one request. The folder
 * tree needs all of them to decrypt names created on other devices; fetching
 * per-folder would be an N+1 round trip on every catalog refresh.
 */
export async function fetchFolderEnvelopes(): Promise<RelayFolderEnvelope[]> {
  const res = await fetch("/api/folder-envelopes");
  if (!res.ok) {
    throw new Error(`failed to load folder envelopes: ${res.status}`);
  }
  return (await res.json()) as RelayFolderEnvelope[];
}

/**
 * Fetch this device's envelope for a file and open it. Returns null when no
 * envelope exists for this device (e.g. the file was uploaded before F2).
 */
export async function fetchAndOpenFileKey(
  fileId: string,
  deviceId: string,
): Promise<Uint8Array | null> {
  const envelopes = await fetchEnvelopes(fileId);
  const mine = envelopes.find((e) => e.recipient_id === deviceId);
  if (!mine) return null;
  // Envelopes are sealed to this device's X25519 encryption identity (ADR-0008).
  return openFekFromEnvelopeX25519(
    mine.encrypted_key,
    encryptionPrivateKeyBytes(getOrCreateEncryptionIdentity()),
  );
}

/**
 * Open this device's folder-key envelope from an already-fetched list using its
 * X25519 encryption identity (ADR-0008).
 */
export function openFolderKeyFromEnvelopes(
  envelopes: RelayFolderEnvelope[],
  folderId: string,
  deviceId: string,
): Uint8Array | null {
  return sdkOpenFolderKeyFromEnvelopes(
    envelopes,
    folderId,
    deviceId,
    encryptionPrivateKeyBytes(getOrCreateEncryptionIdentity()),
  );
}

/** Collect this account's recipients using the web device/node catalogue. */
export function collectRecipients(self: {
  deviceId: string;
  edPublicKey: Uint8Array;
  /** This device's published X25519 key, so its own envelope seals to the key it opens with. */
  x25519PublicKey?: Uint8Array;
  recoveryPublicKey?: string | null;
}): Promise<EnvelopeRecipient[]> {
  return sdkCollectRecipients(self, { listDevices, listNodes });
}
