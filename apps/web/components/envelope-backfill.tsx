"use client";

// Silently re-seals this device's existing file/folder keys to devices that
// registered after those keys were uploaded, so a second device (e.g. a phone)
// can read the account's files without needing the recovery phrase.
//
// Mounted once in the signed-in dashboard. Best-effort and non-blocking: a
// failure must never surface or delay the UI, and the work runs at most once per
// mount. Coverage checks make it idempotent across sessions.

import { useEffect, useRef } from "react";
import { identityPublicKey } from "@repo/relay-client";

import { useAuth } from "../providers/auth-provider";
import { useEventBatch } from "../lib/use-event-batch";
import { getCachedCatalog, getCachedFolders } from "../lib/catalog";
import { refreshCatalog } from "../lib/files";
import { refreshFolders } from "../lib/folders";
import { listDevices } from "../lib/pairing";
import {
  collectRecipients,
  encryptionPublicKeyBytes,
  fetchAndOpenFileKey,
  fetchEnvelopeSummary,
  fetchFolderEnvelopes,
  openFolderKeyFromEnvelopes,
} from "../lib/envelopes";
import { getOrCreateEncryptionIdentity } from "../lib/device";
import { getFileKey } from "../lib/keys";
import { getFolderKey } from "../lib/folder-keys";
import { nextOriginSequence } from "../lib/sync-state";
import { backfillMissingEnvelopes } from "../lib/envelope-backfill";

export function EnvelopeBackfill() {
  const { device, session } = useAuth();
  const sendEventBatch = useEventBatch();
  const startedRef = useRef(false);

  useEffect(() => {
    if (!device || startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        // Refresh first so the cache is a complete snapshot of what needs
        // covering; the summary tells us which devices are already complete.
        const [, , devices, summary] = await Promise.all([
          refreshCatalog(),
          refreshFolders(),
          listDevices(),
          fetchEnvelopeSummary(),
        ]);
        const [catalog, folders] = await Promise.all([getCachedCatalog(), getCachedFolders()]);

        // Build recipients the same way an upload does, then target the active
        // devices among them that are short of coverage.
        const recipients = await collectRecipients({
          deviceId: device.device_id,
          edPublicKey: identityPublicKey(device),
          x25519PublicKey: encryptionPublicKeyBytes(getOrCreateEncryptionIdentity()),
          recoveryPublicKey: session?.recovery_public_key ?? null,
        });

        await backfillMissingEnvelopes({
          deviceId: device.device_id,
          catalog,
          folders,
          devices,
          summary,
          recipients,
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
        });
      } catch {
        // Best-effort: leave coverage as-is and try again on the next mount.
      }
    })();
  }, [device, session, sendEventBatch]);

  return null;
}
