// Rotate the account recovery key (ADR-0002).
//
// Generates a fresh phrase, enrolls its public key (which drops the old
// recovery envelopes server-side), then re-seals every file/folder key this
// device can open to the new recovery identity and stores the phrase locally.
// Only keys this device holds can be re-sealed; the result reports skipped
// keys so the UI can be honest about coverage.

import { resealRecoveryKeys, toCatalogEntry, type ResealResult, type SessionInfo } from "@repo/sdk";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { fetchMobileFileKey } from "../download/keys";
import { fetchMobileFolderKey } from "../download/folder-keys";
import { relayFiles, relayFolders } from "../relay";
import { nextOriginSequence } from "../store/sync-state";
import type { MobileWs } from "../ws";
import { mobileRecoveryClient } from "./client";

export interface RotateResult {
  phrase: string;
  resealed: ResealResult;
}

export async function rotateRecoveryKey(
  ws: MobileWs,
  device: StoredDeviceIdentity,
  session: SessionInfo,
): Promise<RotateResult> {
  const client = mobileRecoveryClient();
  const phrase = client.createPhrase();
  const publicKey = client.publicKey(phrase);

  // Enroll first: the Relay drops any envelopes sealed to the previous recovery
  // key, so re-sealing must come after or the new envelopes would be lost.
  await client.enroll(publicKey);

  const resealed = await resealRecoveryKeys(
    {
      device: { deviceId: device.device_id },
      listCatalog: async () => (await relayFiles()).map(toCatalogEntry),
      listFolders: relayFolders,
      resolveFileKey: (fileId) => fetchMobileFileKey(device, fileId),
      resolveFolderKey: (folderId) => fetchMobileFolderKey(device, folderId),
      allocateSequence: nextOriginSequence,
      sendEventBatch: (events) => ws.sendEventBatch(events),
    },
    publicKey,
  );

  await client.save(session.account_id, phrase);
  return { phrase, resealed };
}
