"use client";

// Migrate this browser's envelopes onto its published X25519 key (ADR-0008
// phase 2). Wraps the shared `resealKeysForSelf` with the web deps (cached
// catalog, IndexedDB key stores, envelope fallback) and a busy flag.

import { useCallback, useState } from "react";
import { encryptionPublicKeyBytes, resealKeysForSelf } from "@repo/sdk";
import { identityPrivateKey, identityPublicKey } from "@repo/relay-client";

import { useAuth } from "../providers/auth-provider";
import { useEventBatch } from "./use-event-batch";
import { nextOriginSequence } from "./sync-state";
import { getCachedCatalog, getCachedFolders } from "./catalog";
import { getFileKey } from "./keys";
import { getFolderKey } from "./folder-keys";
import { fetchAndOpenFileKey, fetchFolderEnvelopes, openFolderKeyFromEnvelopes } from "./envelopes";
import { getOrCreateEncryptionIdentity } from "./device";

export type { ResealResult } from "@repo/sdk";

export function useSelfReseal() {
  const { device } = useAuth();
  const sendEventBatch = useEventBatch();
  const [busy, setBusy] = useState(false);

  const migrate = useCallback(async () => {
    if (!device) throw new Error("no device identity available");
    const encryption = getOrCreateEncryptionIdentity();
    setBusy(true);
    try {
      return await resealKeysForSelf(
        {
          device: { deviceId: device.device_id, edPrivateSeed: identityPrivateKey(device) },
          listCatalog: getCachedCatalog,
          listFolders: getCachedFolders,
          resolveFileKey: async (fileId) => {
            const local = await getFileKey(fileId);
            if (local) return local;
            try {
              return (
                (await fetchAndOpenFileKey(fileId, device.device_id, identityPrivateKey(device))) ??
                null
              );
            } catch {
              return null;
            }
          },
          resolveFolderKey: async (folderId) => {
            const local = await getFolderKey(folderId);
            if (local) return local;
            try {
              return openFolderKeyFromEnvelopes(
                await fetchFolderEnvelopes(),
                folderId,
                device.device_id,
                identityPrivateKey(device),
              );
            } catch {
              return null;
            }
          },
          allocateSequence: nextOriginSequence,
          sendEventBatch,
        },
        {
          deviceId: device.device_id,
          edPublicKey: identityPublicKey(device),
          x25519PublicKey: encryptionPublicKeyBytes(encryption),
        },
      );
    } finally {
      setBusy(false);
    }
  }, [device, sendEventBatch]);

  return { migrate, busy };
}
