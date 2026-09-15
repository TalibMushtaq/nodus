// Native file metadata mutations (rename / soft-delete).
//
// Both are sync events: rename re-emits FILE_CREATED with a re-encrypted name
// (the FEK is unchanged), delete emits TOMBSTONE_CREATED. The event builders
// live in @repo/sdk; this binds them to the mobile device, FEK store, sequence
// allocator and Relay socket.

import { encryptName } from "@repo/core";
import { fileDeletedEvent, fileUpsertEvent } from "@repo/sdk";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { fetchMobileFileKey } from "../download/keys";
import type { RelayFile } from "../relay";
import { nextOriginSequence } from "../store/sync-state";
import type { MobileWs } from "../ws";

export interface MobileFileMutations {
  rename(file: RelayFile, newName: string): Promise<void>;
  /** Re-parent a file without re-encrypting its name (the FEK is unchanged). */
  move(file: RelayFile, parentFolderId: string | null): Promise<void>;
  remove(fileId: string): Promise<void>;
}

export function mobileFileMutations(ws: MobileWs, device: StoredDeviceIdentity): MobileFileMutations {
  return {
    async rename(file, newName) {
      const fek = await fetchMobileFileKey(device, file.file_id);
      if (!fek) throw new Error("This device has no key for that file.");
      const sequence = await nextOriginSequence(device.device_id);
      const ack = await ws.sendEventBatch([
        fileUpsertEvent(device.device_id, sequence, file.file_id, {
          parentFolderId: file.parent_folder_id,
          encryptedName: encryptName(newName, fek),
        }),
      ]);
      if (ack && ack.ok === false) throw new Error(ack.reason ?? "rename rejected");
    },

    async move(file, parentFolderId) {
      // A move is the same FILE_CREATED upsert as a rename, but the name
      // ciphertext is reused verbatim; without it the projection would blank
      // the name, so refuse rather than emit a partial upsert.
      if (!file.encrypted_name) throw new Error("This file has no stored name to move.");
      const sequence = await nextOriginSequence(device.device_id);
      const ack = await ws.sendEventBatch([
        fileUpsertEvent(device.device_id, sequence, file.file_id, {
          parentFolderId,
          encryptedName: file.encrypted_name,
        }),
      ]);
      if (ack && ack.ok === false) throw new Error(ack.reason ?? "move rejected");
    },

    async remove(fileId) {
      const sequence = await nextOriginSequence(device.device_id);
      const ack = await ws.sendEventBatch([fileDeletedEvent(device.device_id, sequence, fileId)]);
      if (ack && ack.ok === false) throw new Error(ack.reason ?? "delete rejected");
    },
  };
}
