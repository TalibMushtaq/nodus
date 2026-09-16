"use client";

// React binding for the shared @repo/sdk folder mutations.
//
// The create/rename/delete ordering, the folder-key durability gate, and the
// best-effort envelope distribution live in the SDK; this hook only supplies
// the browser deps (device identity, IndexedDB key store, event batch, sync
// sequence, and the web device/node catalogue).

import { useMemo } from "react";
import { createFolderMutations, type FolderMutations } from "@repo/sdk";
import { identityPublicKey } from "@repo/relay-client";

import { useAuth } from "../providers/auth-provider";
import { useEventBatch } from "./use-event-batch";
import { nextOriginSequence } from "./sync-state";
import { getFolderKey, putFolderKey } from "./folder-keys";
import { encryptionPublicKeyBytes, fetchFolderEnvelopes, openFolderKeyFromEnvelopes } from "./envelopes";
import { listDevices, listNodes } from "./pairing";
import { getOrCreateEncryptionIdentity } from "./device";

export interface UseFolderMutations extends FolderMutations {
  /** True once a device identity is available. */
  ready: boolean;
}

export function useFolderMutations(): UseFolderMutations {
  const { device, session } = useAuth();
  const sendEventBatch = useEventBatch();

  return useMemo(() => {
    if (!device) {
      const fail = (): never => {
        throw new Error("no device identity available");
      };
      return {
        create: async () => fail(),
        rename: async () => fail(),
        remove: async () => fail(),
        loadFolderKey: async () => null,
        ready: false,
      };
    }

    const mutations = createFolderMutations({
      device: {
        deviceId: device.device_id,
        edPublicKey: identityPublicKey(device),
        // Seal this device's own folder-key envelope to its standalone X25519
        // key, matching the opener (ADR-0008).
        x25519PublicKey: encryptionPublicKeyBytes(getOrCreateEncryptionIdentity()),
      },
      recoveryPublicKey: session?.recovery_public_key ?? null,
      putFolderKey,
      getFolderKey,
      // Local copy first (handled by loadFolderKey), then this device's sealed
      // folder envelope opened with its X25519 encryption key (ADR-0008).
      resolveFolderKey: async (folderId) => {
        try {
          return openFolderKeyFromEnvelopes(await fetchFolderEnvelopes(), folderId, device.device_id);
        } catch {
          return null;
        }
      },
      allocateSequence: nextOriginSequence,
      sendEventBatch,
      recipientSources: { listDevices, listNodes },
    });
    return { ...mutations, ready: true };
  }, [device, session, sendEventBatch]);
}
