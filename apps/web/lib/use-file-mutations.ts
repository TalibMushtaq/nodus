"use client";

import { useCallback } from "react";
import { encryptName } from "@repo/core";
import { identityPrivateKey } from "@repo/relay-client";

import { useAuth } from "../providers/auth-provider";
import { useEventBatch } from "./use-event-batch";
import { nextOriginSequence } from "./sync-state";
import { getFileKey } from "./keys";
import { fetchAndOpenFileKey } from "./envelopes";
import { fileDeletedEvent, fileUpsertEvent } from "./file-events";

/**
 * File metadata mutations (rename / delete) for the Files UI.
 *
 * Both emit a single sync event through the shared batch sender. Rename needs
 * the file's FEK to re-encrypt the new name, so it prefers this device's local
 * key and falls back to its Relay key envelope.
 */
export function useFileMutations() {
  const { device } = useAuth();
  const sendEventBatch = useEventBatch();

  const loadFileKey = useCallback(
    async (fileId: string): Promise<Uint8Array> => {
      if (!device) {
        throw new Error("no device identity available");
      }
      let fek = await getFileKey(fileId);
      if (!fek) {
        fek =
          (await fetchAndOpenFileKey(fileId, device.device_id, identityPrivateKey(device))) ?? undefined;
      }
      if (!fek) {
        throw new Error("This device has no key for that file.");
      }
      return fek;
    },
    [device],
  );

  const rename = useCallback(
    async (fileId: string, parentFolderId: string | null, newName: string): Promise<void> => {
      if (!device) {
        throw new Error("no device identity available");
      }
      const fek = await loadFileKey(fileId);
      const encryptedName = encryptName(newName, fek);
      const sequence = await nextOriginSequence(device.device_id);
      const ack = await sendEventBatch([
        fileUpsertEvent(device.device_id, sequence, fileId, { parentFolderId, encryptedName }),
      ]);
      if (ack && ack.ok === false) {
        throw new Error(ack.reason ?? "rename rejected");
      }
    },
    [device, loadFileKey, sendEventBatch],
  );

  const remove = useCallback(
    async (fileId: string): Promise<void> => {
      if (!device) {
        throw new Error("no device identity available");
      }
      const sequence = await nextOriginSequence(device.device_id);
      const ack = await sendEventBatch([fileDeletedEvent(device.device_id, sequence, fileId)]);
      if (ack && ack.ok === false) {
        throw new Error(ack.reason ?? "delete rejected");
      }
    },
    [device, sendEventBatch],
  );

  return { rename, remove, ready: Boolean(device) };
}
