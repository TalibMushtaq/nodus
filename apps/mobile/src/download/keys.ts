// Resolve a file's FEK on this device.
//
// Prefers the locally persisted key (this device's own upload), then opens this
// device's sealed Relay envelope with its X25519 encryption identity (ADR-0008).
// Shared by the download deps and the name decryption used by the file list, so
// both take the same path (and see the same `null` when no envelope exists).

import { encryptionPrivateKeyBytes, openFekFromEnvelopeX25519 } from "@repo/sdk";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { relayEnvelopes } from "../relay";
import { loadOrCreateEncryptionIdentity } from "../storage";
import { getFileKey } from "../store/keys";

export async function fetchMobileFileKey(
  device: StoredDeviceIdentity,
  fileId: string,
): Promise<Uint8Array | null> {
  const local = await getFileKey(fileId);
  if (local) return local;

  const envelopes = await relayEnvelopes(fileId);
  const mine = envelopes.find((e) => e.recipient_id === device.device_id);
  if (!mine) return null;
  const encryption = await loadOrCreateEncryptionIdentity();
  return openFekFromEnvelopeX25519(mine.encrypted_key, encryptionPrivateKeyBytes(encryption));
}
