import { describe, expect, it } from "vitest";
import {
  encryptName,
  encryptShard,
  generateFileEncryptionKey,
  hashShard,
  packEncryptedShard,
} from "@repo/core";
import type { FileId, ShardIndex } from "@repo/core";

import { MissingEnvelopeError, ShardIntegrityError, ShardUnavailableError, downloadFile } from "../download";
import type { DownloadDeps } from "../download";
import type { RelayFileLocation } from "../catalog";

const fileId = "file-1" as FileId;

function setup(shards: Uint8Array[], fek: Uint8Array) {
  const packed = shards.map((data, index) =>
    packEncryptedShard(encryptShard({ fileId, index: index as ShardIndex, data }, fek)),
  );
  const locations: RelayFileLocation[] = packed.map((bytes, index) => ({
    version_number: 1,
    shard_index: index,
    node_id: "node-1",
    status: "NODE_STORED",
    hash: hashShard(bytes),
    size_bytes: bytes.length,
  }));
  return { packed, locations };
}

function depsFor(fek: Uint8Array | null, packed: Uint8Array[], locations: RelayFileLocation[]): DownloadDeps {
  return {
    fetchFileKey: async () => fek,
    getShardLocations: async () => locations,
    fetchShard: async (_fileId, location) => packed[location.shard_index]!,
  };
}

describe("downloadFile", () => {
  it("fetches, verifies, decrypts and reconstructs across shards (out-of-order locations)", async () => {
    const fek = generateFileEncryptionKey();
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { packed, locations } = setup([original.slice(0, 3), original.slice(3, 6), original.slice(6)], fek);
    // Reverse the manifest to prove reconstruction is by shard index, not arrival order.
    const reversed = [...locations].reverse();

    const result = await downloadFile({
      fileId,
      versionNumber: 1,
      shardCount: 3,
      encryptedName: encryptName("notes.txt", fek),
      deps: depsFor(fek, packed, reversed),
    });

    expect(Array.from(result.data)).toEqual(Array.from(original));
    expect(result.name).toBe("notes.txt");
  });

  it("throws MissingEnvelopeError when this device has no FEK", async () => {
    const fek = generateFileEncryptionKey();
    const { packed, locations } = setup([new Uint8Array([1])], fek);
    await expect(
      downloadFile({ fileId, versionNumber: 1, shardCount: 1, deps: depsFor(null, packed, locations) }),
    ).rejects.toBeInstanceOf(MissingEnvelopeError);
  });

  it("rejects a shard whose ciphertext hash does not match before decrypting", async () => {
    const fek = generateFileEncryptionKey();
    const { packed, locations } = setup([new Uint8Array([1, 2, 3])], fek);
    locations[0]!.hash = "0".repeat(64);
    await expect(
      downloadFile({ fileId, versionNumber: 1, shardCount: 1, deps: depsFor(fek, packed, locations) }),
    ).rejects.toBeInstanceOf(ShardIntegrityError);
  });

  it("throws ShardUnavailableError for a still-buffered shard", async () => {
    const fek = generateFileEncryptionKey();
    const { packed, locations } = setup([new Uint8Array([1])], fek);
    locations[0]!.status = "RELAY_BUFFERED";
    await expect(
      downloadFile({ fileId, versionNumber: 1, shardCount: 1, deps: depsFor(fek, packed, locations) }),
    ).rejects.toBeInstanceOf(ShardUnavailableError);
  });
});
