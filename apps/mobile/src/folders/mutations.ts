// Native binding for the shared @repo/sdk folder mutations.
//
// Supplies the mobile deps: the device identity, the SQLite key store (folder
// keys share the file-key table), the sync-sequence allocator, event batches
// over the Relay socket, the native device/node catalogue, and the bulk
// folder-envelope fetch.

import { createFolderMutations, type FolderMutations, type SessionInfo } from "@repo/sdk";
import {
  identityPrivateKey,
  identityPublicKey,
  type StoredDeviceIdentity,
} from "@repo/relay-client";

import { relayDevices, relayFolderEnvelopes, relayNodes } from "../relay";
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
      edPrivateSeed: identityPrivateKey(device),
    },
    recoveryPublicKey: session?.recovery_public_key ?? null,
    putFolderKey: putFileKey,
    getFolderKey: getFileKey,
    allocateSequence: nextOriginSequence,
    sendEventBatch: (events) => ws.sendEventBatch(events),
    recipientSources: { listDevices: relayDevices, listNodes: relayNodes },
    listFolderEnvelopes: relayFolderEnvelopes,
  });
}
