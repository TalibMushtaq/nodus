// Decrypt display names for the file list.
//
// Filenames are encrypted with the same FEK as the content, so listing them
// requires this device's envelope (or a locally cached key). A file with no
// envelope for this device, or a decryption failure, renders as null so the UI
// can fall back to the file id rather than fail the whole listing.

import { decryptName } from "@repo/core";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import type { RelayFile, RelayTombstone } from "../relay";
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
 * Decrypt names for soft-deleted items. Folder names use folder keys, which
 * mobile does not resolve yet, so only file tombstones decrypt; the rest fall
 * back to the id.
 */
export async function decryptTombstoneNames(
  device: StoredDeviceIdentity,
  items: RelayTombstone[],
): Promise<Record<string, string | null>> {
  const names: Record<string, string | null> = {};
  await Promise.all(
    items.map(async (item) => {
      if (item.entity_type !== "file" || !item.encrypted_name) {
        names[item.entity_id] = null;
        return;
      }
      try {
        const fek = await fetchMobileFileKey(device, item.entity_id);
        names[item.entity_id] = fek ? decryptName(item.encrypted_name, fek) : null;
      } catch {
        names[item.entity_id] = null;
      }
    }),
  );
  return names;
}
