// Native binding for the shared @repo/sdk folder mutations.
//
// Supplies the mobile deps: the device identity, the SQLite key store (folder
// keys share the file-key table), the sync-sequence allocator, event batches
// over the Relay socket, the native device/node catalogue, and folder-key
// resolution (local copy or this device's sealed envelope).

import { createFolderMutations, type FolderMutations, type SessionInfo } from "@repo/sdk";
import { identityPublicKey, type StoredDeviceIdentity } from "@repo/relay-client";

import { fetchMobileFolderKey } from "../download/folder-keys";
import { relayDevices, relayNodes } from "../relay";
import { getFileKey, putFileKey } from "../store/keys";
import { nextOriginSequence } from "../store/sync-state";
import type { MobileWs } from "../ws";

export function mobileFolderMutations(
  ws: MobileWs,
  device: StoredDeviceIdentity,
  session: SessionInfo | null,
): FolderMutations {
  return createFolderMutations({
    device: {
      deviceId: device.device_id,
      edPublicKey: identityPublicKey(device),
    },
    recoveryPublicKey: session?.recovery_public_key ?? null,
    putFolderKey: putFileKey,
    getFolderKey: getFileKey,
    resolveFolderKey: (folderId) => fetchMobileFolderKey(device, folderId),
    allocateSequence: nextOriginSequence,
    sendEventBatch: (events) => ws.sendEventBatch(events),
    recipientSources: { listDevices: relayDevices, listNodes: relayNodes },
  });
}
