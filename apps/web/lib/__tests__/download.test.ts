import { describe, expect, it } from "vitest";
import {
  encryptName,
  encryptShard,
  generateFileEncryptionKey,
  hashShard,
  packEncryptedShard,
} from "@repo/core";
import type { FileId, ShardIndex } from "@repo/core";

import {
  DownloadCancelledError,
  MissingEnvelopeError,
  ShardIntegrityError,
  ShardUnavailableError,
  downloadFile,
} from "../download";
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

  it("reports unlocking, fetching, verifying, decrypting and done in order", async () => {
    const fek = generateFileEncryptionKey();
    const original = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const { packed, locations } = setup([original.slice(0, 3), original.slice(3)], fek);
    const phases: string[] = [];
    let last: { completedShards: number; totalShards: number; completedBytes: number; totalBytes: number } | null =
      null;

    await downloadFile({
      fileId,
      versionNumber: 1,
      shardCount: 2,
      deps: depsFor(fek, packed, locations),
      onProgress: (event) => {
        phases.push(event.phase);
        last = event;
      },
    });

    expect(phases[0]).toBe("unlocking");
    expect(phases).toContain("fetching");
    expect(phases).toContain("verifying");
    expect(phases).toContain("decrypting");
    expect(phases[phases.length - 1]).toBe("done");
    // The final event accounts for every shard and the declared ciphertext size.
    expect(last).toMatchObject({
      completedShards: 2,
      totalShards: 2,
      completedBytes: packed.reduce((sum, bytes) => sum + bytes.length, 0),
      totalBytes: packed.reduce((sum, bytes) => sum + bytes.length, 0),
    });
  });

  it("labels the first shard's route negotiation as connecting before any bytes", async () => {
    const fek = generateFileEncryptionKey();
    const { packed, locations } = setup([new Uint8Array([1, 2, 3])], fek);

    const phases: string[] = [];
    await downloadFile({
      fileId,
      versionNumber: 1,
      shardCount: 1,
      deps: depsFor(fek, packed, locations),
      onProgress: (event) => phases.push(event.phase),
    });

    // The wait for the first shard's transport must read as "connecting", not a
    // frozen "fetching 0 B"; the shard then verifies/decrypts normally.
    expect(phases[0]).toBe("unlocking");
    expect(phases[1]).toBe("connecting");
    expect(phases).toContain("verifying");
    expect(phases[phases.length - 1]).toBe("done");
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

  it("downloads a relay-buffered shard before a node has picked it up", async () => {
    const fek = generateFileEncryptionKey();
    const { packed, locations } = setup([new Uint8Array([9, 8, 7])], fek);
    locations[0]!.status = "RELAY_BUFFERED";

    const result = await downloadFile({
      fileId,
      versionNumber: 1,
      shardCount: 1,
      deps: depsFor(fek, packed, locations),
    });

    expect(Array.from(result.data)).toEqual([9, 8, 7]);
  });

  it("surfaces mid-shard byte progress from a streaming transport", async () => {
    const fek = generateFileEncryptionKey();
    const original = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const { packed, locations } = setup([original.slice(0, 3), original.slice(3)], fek);

    const reported: number[] = [];
    const deps: DownloadDeps = {
      fetchFileKey: async () => fek,
      getShardLocations: async () => locations,
      // Mimic a streaming transport: report bytes in two chunks before resolving.
      fetchShard: async (_fileId, location, onProgress) => {
        const bytes = packed[location.shard_index]!;
        onProgress?.(Math.floor(bytes.length / 2), bytes.length);
        onProgress?.(bytes.length, bytes.length);
        return bytes;
      },
    };

    await downloadFile({
      fileId,
      versionNumber: 1,
      shardCount: 2,
      deps,
      onProgress: (event) => {
        if (event.phase === "fetching") reported.push(event.completedBytes);
      },
    });

    // Bytes advanced before the shard finished, not only at shard boundaries.
    expect(reported.length).toBeGreaterThan(2);
    const totalBytes = packed.reduce((sum, bytes) => sum + bytes.length, 0);
    // The final fetching event after each completed shard accounts for all bytes.
    expect(reported[reported.length - 1]).toBe(totalBytes);
  });

  it("rejects with DownloadCancelledError when the signal is already aborted", async () => {
    const fek = generateFileEncryptionKey();
    const { packed, locations } = setup([new Uint8Array([1])], fek);
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadFile({
        fileId,
        versionNumber: 1,
        shardCount: 1,
        deps: depsFor(fek, packed, locations),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(DownloadCancelledError);
  });

  it("cancels a download that is mid-shard", async () => {
    const fek = generateFileEncryptionKey();
    const { locations } = setup([new Uint8Array([1, 2, 3])], fek);
    const controller = new AbortController();

    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const deps: DownloadDeps = {
      fetchFileKey: async () => fek,
      getShardLocations: async () => locations,
      // A transport that hangs until aborted, proving the in-flight fetch is
      // actually cancelled rather than merely ignored at the next checkpoint.
      fetchShard: (_fileId, _location, _onProgress, signal) => {
        entered();
        return new Promise<Uint8Array>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    };

    const promise = downloadFile({
      fileId,
      versionNumber: 1,
      shardCount: 1,
      deps,
      signal: controller.signal,
    });
    await enteredPromise;
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(DownloadCancelledError);
  });

  it("throws ShardUnavailableError when a shard has no fetchable copy yet", async () => {
    const fek = generateFileEncryptionKey();
    const { packed, locations } = setup([new Uint8Array([1])], fek);
    // Mid-upload: the buffer row exists but is not yet committed to the buffer.
    locations[0]!.status = "UPLOADING";
    await expect(
      downloadFile({ fileId, versionNumber: 1, shardCount: 1, deps: depsFor(fek, packed, locations) }),
    ).rejects.toBeInstanceOf(ShardUnavailableError);
  });
});
