// Decrypt display names for the file list.
//
// Filenames are encrypted with the same FEK as the content, so listing them
// requires this device's envelope (or a locally cached key). A file with no
// envelope for this device, or a decryption failure, renders as null so the UI
// can fall back to the file id rather than fail the whole listing.

import { decryptName } from "@repo/core";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import type { RelayFile } from "../relay";
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
