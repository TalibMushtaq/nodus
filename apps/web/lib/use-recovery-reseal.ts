"use client";

import { useCallback, useState } from "react";
import { identityPrivateKey } from "@repo/relay-client";
import type { EventPayload } from "@repo/protocol";

import { useAuth } from "../providers/auth-provider";
import { useEventBatch } from "./use-event-batch";
import { nextOriginSequence } from "./sync-state";
import { getCachedCatalog, getCachedFolders } from "./catalog";
import { getFileKey } from "./keys";
import { getFolderKey } from "./folder-keys";
import {
  decodeRecipientPublicKey,
  envelopeEvent,
  fetchAndOpenFileKey,
  fetchFolderEnvelopes,
  folderEnvelopeEvent,
  openFolderKeyFromEnvelopes,
  sealFekForRecipients,
} from "./envelopes";
import type { RelayFolderEnvelope } from "./envelopes";

// Envelope batches are chunked so a large account does not exceed the Relay's
// message size in one event_batch frame.
const RESEAL_BATCH_SIZE = 200;

export interface ResealResult {
  files: number;
  folders: number;
  /** Keys this device could not open, so could not re-seal to recovery. */
  skipped: number;
}

/**
 * Re-seal every file/folder key this device can open to the account recovery
 * identity. Used when recovery is first enrolled and after the key is
 * regenerated. Only keys this device holds (locally or via its own envelope)
 * can be re-sealed; the result reports how many were skipped so the UI can be
 * honest that coverage may be partial.
 */
export function useRecoveryReseal() {
  const { device } = useAuth();
  const sendEventBatch = useEventBatch();
  const [busy, setBusy] = useState(false);

  const reseal = useCallback(
    async (recoveryPublicKey: string): Promise<ResealResult> => {
      if (!device) throw new Error("no device identity available");
      setBusy(true);
      try {
        const recipient = {
          recipientId: recoveryPublicKey,
          recipientKind: "recovery" as const,
          edPublicKey: decodeRecipientPublicKey(recoveryPublicKey, "recovery"),
        };
        const [catalog, folders] = await Promise.all([getCachedCatalog(), getCachedFolders()]);
        const events: EventPayload[] = [];
        let files = 0;
        let foldersSealed = 0;
        let skipped = 0;

        for (const entry of catalog) {
          const fek = await openFileKey(entry.file_id);
          if (!fek) {
            skipped += 1;
            continue;
          }
          const sealed = sealFekForRecipients(fek, [recipient])[0]!;
          const sequence = await nextOriginSequence(device.device_id);
          events.push(envelopeEvent(device.device_id, sequence, entry.file_id, sealed));
          files += 1;
        }

        let folderEnvelopes: RelayFolderEnvelope[] = [];
        try {
          folderEnvelopes = await fetchFolderEnvelopes();
        } catch {
          // Local keys still cover this device's own folders.
        }
        for (const folder of folders) {
          let fk = await getFolderKey(folder.folder_id);
          if (!fk) {
            try {
              fk =
                openFolderKeyFromEnvelopes(
                  folderEnvelopes,
                  folder.folder_id,
                  device.device_id,
                  identityPrivateKey(device),
                ) ?? undefined;
            } catch {
              fk = undefined;
            }
          }
          if (!fk) {
            skipped += 1;
            continue;
          }
          const sealed = sealFekForRecipients(fk, [recipient])[0]!;
          const sequence = await nextOriginSequence(device.device_id);
          events.push(folderEnvelopeEvent(device.device_id, sequence, folder.folder_id, sealed));
          foldersSealed += 1;
        }

        for (let index = 0; index < events.length; index += RESEAL_BATCH_SIZE) {
          const ack = await sendEventBatch(events.slice(index, index + RESEAL_BATCH_SIZE));
          if (ack && ack.ok === false) {
            throw new Error(ack.reason ?? "recovery re-seal batch rejected");
          }
        }

        return { files, folders: foldersSealed, skipped };
      } finally {
        setBusy(false);
      }

      // Local FEK first, then this device's Relay envelope (a file uploaded from
      // another device). Returns null when this device cannot open the key.
      async function openFileKey(fileId: string): Promise<Uint8Array | null> {
        const local = await getFileKey(fileId);
        if (local) return local;
        try {
          return (await fetchAndOpenFileKey(fileId, device!.device_id, identityPrivateKey(device!))) ?? null;
        } catch {
          return null;
        }
      }
    },
    [device, sendEventBatch],
  );

  return { reseal, busy };
}
