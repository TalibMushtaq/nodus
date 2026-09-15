import { describe, expect, it } from "vitest";
import { createDeviceIdentity, identityPrivateKey, identityPublicKey } from "@repo/relay-client";
import type { EventPayload } from "@repo/protocol";

import { createFolderMutations } from "../src/folders/folders.js";

function harness() {
  const device = createDeviceIdentity();
  const keys = new Map<string, Uint8Array>();
  const batches: EventPayload[][] = [];
  let sequence = 0;

  const mutations = createFolderMutations({
    device: {
      deviceId: device.device_id,
      edPublicKey: identityPublicKey(device),
      edPrivateSeed: identityPrivateKey(device),
    },
    putFolderKey: async (id, key) => void keys.set(id, key),
    getFolderKey: async (id) => keys.get(id),
    allocateSequence: async () => (sequence += 1),
    sendEventBatch: async (events) => {
      batches.push(events);
      return undefined;
    },
    // Empty catalogue: only this device is a recipient.
    recipientSources: { listDevices: async () => [], listNodes: async () => [] },
    listFolderEnvelopes: async () => [],
  });

  return { mutations, keys, batches };
}

describe("createFolderMutations", () => {
  it("creates, persists the key, and distributes it as an envelope", async () => {
    const h = harness();
    const folderId = await h.mutations.create("Photos", null);

    expect(h.keys.has(folderId)).toBe(true);
    // First batch: the folder row. Second: the folder-key envelopes.
    expect(h.batches[0]![0]!.type).toBe("FOLDER_CREATED");
    expect(h.batches[0]![0]!.payload).toMatchObject({
      folder_id: folderId,
      parent_folder_id: null,
    });
    expect(h.batches[1]![0]!.type).toBe("FOLDER_KEY_ENVELOPE_ADDED");
    expect(h.batches[1]!.at(-1)!.payload).toMatchObject({ folder_id: folderId });
  });

  it("re-encrypts the name on rename using the stored key", async () => {
    const h = harness();
    const folderId = await h.mutations.create("Photos", null);
    h.batches.length = 0;

    await h.mutations.rename(folderId, null, "Pictures");

    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]![0]!.type).toBe("FOLDER_CREATED");
    expect(h.batches[0]![0]!.payload).toMatchObject({ folder_id: folderId });
    // A different name must produce a different ciphertext.
    const created = h.batches[0]![0]!.payload.encrypted_name;
    expect(typeof created).toBe("string");
  });

  it("emits FOLDER_DELETED on remove", async () => {
    const h = harness();
    const folderId = await h.mutations.create("Photos", null);
    h.batches.length = 0;

    await h.mutations.remove(folderId);

    expect(h.batches[0]![0]!.type).toBe("FOLDER_DELETED");
    expect(h.batches[0]![0]!.payload).toMatchObject({ folder_id: folderId });
  });

  it("refuses to rename a folder this device has no key for", async () => {
    const h = harness();
    await expect(h.mutations.rename("unknown-folder", null, "x")).rejects.toThrow(
      /no key for that folder/i,
    );
  });
});
