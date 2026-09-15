// Decrypt display names for the file list.
//
// Filenames are encrypted with the same FEK as the content, so listing them
// requires this device's envelope (or a locally cached key). A file with no
// envelope for this device, or a decryption failure, renders as null so the UI
// can fall back to the file id rather than fail the whole listing.

import { decryptName } from "@repo/core";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import type { RelayFile, RelayFolder, RelayTombstone } from "../relay";
import { fetchMobileFolderKey } from "./folder-keys";
import { fetchMobileFileKey } from "./keys";

export async function decryptFileNames(
  device: StoredDeviceIdentity,
  files: RelayFile[],
): Promise<Record<string, string | null>> {
  const names: Record<string, string | null> = {};
  await Promise.all(
    files.map(async (file) => {
      if (!file.encrypted_name) {
        names[file.file_id] = null;
        return;
      }
      try {
        const fek = await fetchMobileFileKey(device, file.file_id);
        names[file.file_id] = fek ? decryptName(file.encrypted_name, fek) : null;
      } catch {
        // Missing/undecryptable envelope: show the id, not an error.
        names[file.file_id] = null;
      }
    }),
  );
  return names;
}

/**
 * Decrypt folder names, using each folder's key (local or sealed envelope).
 * A folder with no key for this device renders as null so the UI falls back to
 * the id.
 */
export async function decryptFolderNames(
  device: StoredDeviceIdentity,
  folders: RelayFolder[],
): Promise<Record<string, string | null>> {
  const names: Record<string, string | null> = {};
  await Promise.all(
    folders.map(async (folder) => {
      if (!folder.encrypted_name) {
        names[folder.folder_id] = null;
        return;
      }
      try {
        const key = await fetchMobileFolderKey(device, folder.folder_id);
        names[folder.folder_id] = key ? decryptName(folder.encrypted_name, key) : null;
      } catch {
        names[folder.folder_id] = null;
      }
    }),
  );
  return names;
}

/**
 * Decrypt names for soft-deleted items. Folder names use folder keys; file
 * tombstones use the FEK. Anything this device cannot open falls back to the id.
 */
export async function decryptTombstoneNames(
  device: StoredDeviceIdentity,
  items: RelayTombstone[],
): Promise<Record<string, string | null>> {
  const names: Record<string, string | null> = {};
  await Promise.all(
    items.map(async (item) => {
      if (!item.encrypted_name) {
        names[item.entity_id] = null;
        return;
      }
      try {
        // Files decrypt with the FEK; folders with the folder key.
        const key =
          item.entity_type === "file"
            ? await fetchMobileFileKey(device, item.entity_id)
            : await fetchMobileFolderKey(device, item.entity_id);
        names[item.entity_id] = key ? decryptName(item.encrypted_name, key) : null;
      } catch {
        names[item.entity_id] = null;
      }
    }),
  );
  return names;
}
