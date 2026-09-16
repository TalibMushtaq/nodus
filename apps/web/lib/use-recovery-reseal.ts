"use client";

// Web binding for the shared @repo/sdk recovery re-seal.
//
// The re-seal logic (open every key this device can, seal it to recovery, batch
// the envelope events) lives in the SDK; this hook supplies the browser deps and
// exposes the busy flag the Security card uses.

import { useCallback, useState } from "react";
import { resealRecoveryKeys } from "@repo/sdk";

import { useAuth } from "../providers/auth-provider";
import { useEventBatch } from "./use-event-batch";
import { nextOriginSequence } from "./sync-state";
import { getCachedCatalog, getCachedFolders } from "./catalog";
import { getFileKey } from "./keys";
import { getFolderKey } from "./folder-keys";
import { fetchAndOpenFileKey, fetchFolderEnvelopes, openFolderKeyFromEnvelopes } from "./envelopes";

export type { ResealResult } from "@repo/sdk";

export function useRecoveryReseal() {
  const { device } = useAuth();
  const sendEventBatch = useEventBatch();
  const [busy, setBusy] = useState(false);

  const reseal = useCallback(
    async (recoveryPublicKey: string) => {
      if (!device) throw new Error("no device identity available");
      setBusy(true);
      try {
        return await resealRecoveryKeys(
          {
            device: { deviceId: device.device_id },
            listCatalog: getCachedCatalog,
            listFolders: getCachedFolders,
            // Local FEK first, then this device's Relay envelope; null when this
            // device cannot open the key (counted as skipped).
            resolveFileKey: async (fileId) => {
              const local = await getFileKey(fileId);
              if (local) return local;
              try {
                return (await fetchAndOpenFileKey(fileId, device.device_id)) ?? null;
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
                );
              } catch {
                return null;
              }
            },
            allocateSequence: nextOriginSequence,
            sendEventBatch,
          },
          recoveryPublicKey,
        );
      } finally {
        setBusy(false);
      }
    },
    [device, sendEventBatch],
  );

  return { reseal, busy };
}
