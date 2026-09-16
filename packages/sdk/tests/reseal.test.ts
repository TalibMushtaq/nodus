import { describe, expect, it } from "vitest";
import { generateFileEncryptionKey } from "@repo/core";
import { createDeviceIdentity, identityPublicKey } from "@repo/relay-client";
import type { EventPayload } from "@repo/protocol";

import { resealKeysForSelf } from "../src/recovery/reseal.js";
import {
  createEncryptionIdentity,
  encryptionPrivateKeyBytes,
  encryptionPublicKeyBytes,
} from "../src/device/encryption.js";
import { openFekFromEnvelopeX25519 } from "../src/envelopes/envelopes.js";
import type { CatalogEntry } from "../src/catalog/catalog.js";

function entry(fileId: string): CatalogEntry {
  return {
    file_id: fileId,
    parent_folder_id: null,
    encrypted_name: null,
    created_at: "x",
    updated_at: "x",
    latest_version_number: 1,
    shard_count: 1,
    version_hash: "h",
    conflict_status: "none",
    conflicted_versions: [],
    storage_status: "stored",
    locations: [],
    cached_at: "x",
  };
}

describe("resealKeysForSelf (ADR-0008 phase 2)", () => {
  it("re-seals this device's keys to its published X25519 key", async () => {
    const device = createDeviceIdentity();
    const encryption = createEncryptionIdentity();
    const fek = generateFileEncryptionKey();
    const batches: EventPayload[][] = [];

    const result = await resealKeysForSelf(
      {
        device: { deviceId: device.device_id, edPrivateSeed: new Uint8Array(32) },
        listCatalog: async () => [entry("file-1")],
        listFolders: async () => [],
        // The key is locally available, so no envelope fallback is needed.
        resolveFileKey: async () => fek,
        resolveFolderKey: async () => null,
        allocateSequence: async () => 1,
        sendEventBatch: async (events) => {
          batches.push(events);
        },
      },
      {
        deviceId: device.device_id,
        edPublicKey: identityPublicKey(device),
        x25519PublicKey: encryptionPublicKeyBytes(encryption),
      },
    );

    expect(result.files).toBe(1);
    expect(batches).toHaveLength(1);
    const event = batches[0]![0]!;
    expect(event.type).toBe("KEY_ENVELOPE_ADDED");
    expect(event.payload).toMatchObject({ file_id: "file-1", recipient_id: device.device_id });

    // The emitted envelope must open with the device's X25519 private key.
    const encryptedKey = (event.payload as { encrypted_key: string }).encrypted_key;
    expect(openFekFromEnvelopeX25519(encryptedKey, encryptionPrivateKeyBytes(encryption))).toEqual(fek);
  });
});
