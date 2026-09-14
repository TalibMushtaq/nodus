"use client";

// Folder mutations (create / rename / delete) for the Files UI.
//
// A folder is metadata: creation and rename emit FOLDER_CREATED (both backends
// upsert the folder row, without touching versions) and deletion emits
// FOLDER_DELETED (a tombstone). Folder names are encrypted with a fresh
// per-folder key, so creation must also distribute that key to the account's
// other devices/nodes as FOLDER_KEY_ENVELOPE_ADDED events — otherwise only this
// device could ever render the name. A rename reuses the existing key.

import { useCallback } from "react";
import { encryptName, generateFileEncryptionKey } from "@repo/core";
import { identityPrivateKey, identityPublicKey } from "@repo/relay-client";
import type { EventPayload } from "@repo/protocol";

import { useAuth } from "../providers/auth-provider";
import { useEventBatch } from "./use-event-batch";
import { nextOriginSequence } from "./sync-state";
import { getFolderKey, putFolderKey } from "./folder-keys";
import { folderCreatedEvent, folderDeletedEvent } from "./folder-events";
import {
  collectRecipients,
  fetchFolderEnvelopes,
  folderEnvelopeEvent,
  openFolderKeyFromEnvelopes,
  sealFekForRecipients,
} from "./envelopes";

export function useFolderMutations() {
  const { device, session } = useAuth();
  const sendEventBatch = useEventBatch();

  /**
   * Resolve a folder's key, preferring this device's local copy and falling back
   * to this device's Relay envelope (a folder created on another device). The
   * caller must handle a null result as "no key on this device".
   */
  const loadFolderKey = useCallback(
    async (folderId: string): Promise<Uint8Array | null> => {
      if (!device) throw new Error("no device identity available");
      const local = await getFolderKey(folderId);
      if (local) return local;
      try {
        const envelopes = await fetchFolderEnvelopes();
        return openFolderKeyFromEnvelopes(
          envelopes,
          folderId,
          device.device_id,
          identityPrivateKey(device),
        );
      } catch {
        return null;
      }
    },
    [device],
  );

  const create = useCallback(
    async (name: string, parentFolderId: string | null): Promise<string> => {
      if (!device) {
        throw new Error("no device identity available");
      }
      const folderId = crypto.randomUUID();
      const fek = generateFileEncryptionKey();

      // Durability gate: persist the key before emitting any event that
      // references the folder, so a reload cannot leave an unreadable name
      // (mirrors the uploader's FEK gate).
      await putFolderKey(folderId, fek);
      const encryptedName = encryptName(name, fek);

      const sequence = await nextOriginSequence(device.device_id);
      const ack = await sendEventBatch([
        folderCreatedEvent(device.device_id, sequence, { folderId, parentFolderId, encryptedName }),
      ]);
      if (ack && ack.ok === false) {
        throw new Error(ack.reason ?? "folder create rejected");
      }

      // Distribute the folder key. This runs after the folder row exists (the
      // Relay's foreign-folder guard and the FK both require it). A failure here
      // must not fail creation: the folder exists and is locally readable, and a
      // later device simply shows a short id until distribution succeeds.
      try {
        const recipients = await collectRecipients({
          deviceId: device.device_id,
          edPublicKey: identityPublicKey(device),
          recoveryPublicKey: session?.recovery_public_key ?? null,
        });
        const sealed = sealFekForRecipients(fek, recipients);
        const events: EventPayload[] = [];
        for (const envelope of sealed) {
          const envSequence = await nextOriginSequence(device.device_id);
          events.push(folderEnvelopeEvent(device.device_id, envSequence, folderId, envelope));
        }
        const envAck = await sendEventBatch(events);
        if (envAck && envAck.ok === false) {
          throw new Error(envAck.reason ?? "folder key envelope batch rejected");
        }
      } catch (err) {
        console.warn("folder key distribution failed; name will not sync to other devices", err);
      }

      return folderId;
    },
    [device, session, sendEventBatch],
  );

  const remove = useCallback(
    async (folderId: string): Promise<void> => {
      if (!device) {
        throw new Error("no device identity available");
      }
      const sequence = await nextOriginSequence(device.device_id);
      const ack = await sendEventBatch([folderDeletedEvent(device.device_id, sequence, folderId)]);
      if (ack && ack.ok === false) {
        throw new Error(ack.reason ?? "folder delete rejected");
      }
    },
    [device, sendEventBatch],
  );

  const rename = useCallback(
    async (folderId: string, parentFolderId: string | null, newName: string): Promise<void> => {
      if (!device) {
        throw new Error("no device identity available");
      }
      const fek = await loadFolderKey(folderId);
      if (!fek) {
        throw new Error("This device has no key for that folder.");
      }
      // A rename is a FOLDER_CREATED upsert with a re-encrypted name; the folder
      // key (and therefore every existing name ciphertext) is unchanged.
      const encryptedName = encryptName(newName, fek);
      const sequence = await nextOriginSequence(device.device_id);
      const ack = await sendEventBatch([
        folderCreatedEvent(device.device_id, sequence, { folderId, parentFolderId, encryptedName }),
      ]);
      if (ack && ack.ok === false) {
        throw new Error(ack.reason ?? "folder rename rejected");
      }
    },
    [device, loadFolderKey, sendEventBatch],
  );

  return { create, rename, remove, ready: Boolean(device) };
}
