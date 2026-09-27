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
import { getEncryptionPublicKey, getOrCreateEncryptionIdentity } from "../lib/device";
import { getFileKey } from "../lib/keys";
import { getFolderKey } from "../lib/folder-keys";
import { nextOriginSequence } from "../lib/sync-state";
import { backfillMissingEnvelopes } from "../lib/envelope-backfill";

export function EnvelopeBackfill() {
  const { device, session } = useAuth();
  const sendEventBatch = useEventBatch();
  // The device id the backfill last ran for. Keying on the id (not a boolean)
  // lets the effect re-run when the account/device changes in the same mount —
  // a second login must backfill the new identity, not be skipped as "already
  // started".
  const startedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!device) return;
    if (startedForRef.current === device.device_id) return;
    const identityAtStart = device.device_id;
    startedForRef.current = identityAtStart;
    void (async () => {
      try {
        // Warm the async encryption identity first (migrates legacy storage).
        await getOrCreateEncryptionIdentity();
        // Refresh first so the cache is a complete snapshot of what needs
        // covering; the summary tells us which devices are already complete.
        const [, , devices, summary] = await Promise.all([
          refreshCatalog(),
          refreshFolders(),
          listDevices(),
          fetchEnvelopeSummary(),
        ]);
        // Abort if the account/device changed mid-flight; the effect will have
        // re-run (and reset the marker) for the new identity.
        if (device.device_id !== identityAtStart) return;
        const [catalog, folders] = await Promise.all([getCachedCatalog(), getCachedFolders()]);

        // Build recipients the same way an upload does, then target the active
        // devices among them that are short of coverage. Only the public half
        // is needed for sealing.
        const selfPublic = getEncryptionPublicKey();
        const recipients = await collectRecipients({
          deviceId: device.device_id,
          edPublicKey: identityPublicKey(device),
          ...(selfPublic
            ? {
                x25519PublicKey: encryptionPublicKeyBytes({
                  public_key: selfPublic,
                  private_key: "",
                }),
              }
            : {}),
          recoveryPublicKey: session?.recovery_public_key ?? null,
        });
        // Bulk folder envelopes once (not per folder) for the N+1 fix below.
        const folderEnvelopes = await fetchFolderEnvelopes().catch(() => []);

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
              return (
                (await openFolderKeyFromEnvelopes(folderEnvelopes, folderId, device.device_id)) ??
                null
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
