// Resolve a folder's key on this device.
//
// Folder names are encrypted with a random per-folder key (same primitive as a
// file name). The key is stored under the folder id in the shared SQLite keys
// table for folders this device created, otherwise this device's sealed folder
// envelope is opened from the bulk `GET /folder-envelopes` list.

import { openFolderKeyFromEnvelopes } from "@repo/sdk";
import { identityPrivateKey, type StoredDeviceIdentity } from "@repo/relay-client";

import { relayFolderEnvelopes } from "../relay";
import { getFileKey } from "../store/keys";

export async function fetchMobileFolderKey(
  device: StoredDeviceIdentity,
  folderId: string,
): Promise<Uint8Array | null> {
  // Folder keys share the file-key table: it is an opaque id → 32-byte key map.
  const local = await getFileKey(folderId);
  if (local) return local;

  try {
    const envelopes = await relayFolderEnvelopes();
    return openFolderKeyFromEnvelopes(envelopes, folderId, device.device_id, identityPrivateKey(device));
  } catch {
    return null;
  }
}
