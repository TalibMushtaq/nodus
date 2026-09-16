// Migrate this device's envelopes to its published X25519 key (ADR-0008 phase 2).
//
// Legacy envelopes were sealed to the X25519 key derived from the device's
// Ed25519 seed. Re-sealing them to the standalone X25519 key lets the signing
// seed stop being needed for envelope access.

import {
  encryptionPublicKeyBytes,
  resealKeysForSelf,
  toCatalogEntry,
  type ResealResult,
  type StoredEncryptionIdentity,
} from "@repo/sdk";
import {
  identityPrivateKey,
  identityPublicKey,
  type StoredDeviceIdentity,
} from "@repo/relay-client";

import { fetchMobileFolderKey } from "../download/folder-keys";
import { fetchMobileFileKey } from "../download/keys";
import { relayFiles, relayFolders } from "../relay";
import { nextOriginSequence } from "../store/sync-state";
import type { MobileWs } from "../ws";

export async function resealSelfEnvelopes(
  ws: MobileWs,
  device: StoredDeviceIdentity,
  encryption: StoredEncryptionIdentity,
): Promise<ResealResult> {
  return resealKeysForSelf(
    {
      device: { deviceId: device.device_id, edPrivateSeed: identityPrivateKey(device) },
      listCatalog: async () => (await relayFiles()).map(toCatalogEntry),
      listFolders: relayFolders,
      resolveFileKey: (fileId) => fetchMobileFileKey(device, fileId),
      resolveFolderKey: (folderId) => fetchMobileFolderKey(device, folderId),
      allocateSequence: nextOriginSequence,
      sendEventBatch: (events) => ws.sendEventBatch(events),
    },
    {
      deviceId: device.device_id,
      edPublicKey: identityPublicKey(device),
      x25519PublicKey: encryptionPublicKeyBytes(encryption),
    },
  );
}
