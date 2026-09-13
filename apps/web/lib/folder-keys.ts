// Per-folder key storage for the web client.
//
// Folder names are encrypted with a random per-folder key, exactly like a file's
// name is encrypted with its FEK (see @repo/core `encryptName`). The key must be
// retained locally or a reload loses the only way to render the folder name.
//
// This deliberately reuses the `keys` IndexedDB store and its `file_id` keyPath:
// the record is just an opaque id → 32-byte key mapping, and a folder id is a
// valid string key. Cross-device distribution is handled separately by
// `lib/envelopes.ts` (FOLDER_KEY_ENVELOPE_ADDED), mirroring the file path.

import { getFileKey, putFileKey } from "./keys";

/** Persist a folder's key, keyed by folder_id in the shared keys store. */
export function putFolderKey(folderId: string, fek: Uint8Array): Promise<void> {
  return putFileKey(folderId, fek);
}

/** Read this device's local copy of a folder's key, if it created/received it. */
export function getFolderKey(folderId: string): Promise<Uint8Array | undefined> {
  return getFileKey(folderId);
}
