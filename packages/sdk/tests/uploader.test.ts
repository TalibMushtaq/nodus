import { describe, expect, it } from "vitest";

import { uploadFile, type UploadDeps, type UploadSource } from "../src/upload/uploader.js";
import type { BufferedShardUpload } from "../src/transfer/attempt-path.js";
import type { EventPayload } from "@repo/protocol";

/** In-memory random-access source; mirrors what a File or file handle provides. */
function source(bytes: number[], name = "f.bin"): UploadSource {
  const data = Uint8Array.from(bytes);
  return {
    name,
    size: data.length,
    read: async (offset, length) => data.subarray(offset, offset + length),
  };
}

function harness() {
  const posted: BufferedShardUpload[] = [];
  const batches: EventPayload[][] = [];
  const keys = new Map<string, Uint8Array>();
  let sequence = 0;

  const deps: UploadDeps = {
    postShard: async (dto) => {
      posted.push(dto);
      return { status: "ok" };
    },
    sendEventBatch: async (events) => {
      batches.push(events);
      return undefined;
    },
    allocateSequence: async () => (sequence += 1),
    putFileKey: async (fileId, fek) => void keys.set(fileId, fek),
    getFileKey: async (fileId) => keys.get(fileId),
    saveProgress: async () => undefined,
    getProgress: async () => undefined,
    markShardComplete: async () => undefined,
    clearProgress: async () => undefined,
  };

  return { deps, posted, batches, keys };
}

describe("shared uploader", () => {
  it("announces the file/version before posting a single-shard upload", async () => {
    const h = harness();
    const result = await uploadFile({
      source: source([1, 2, 3, 4]),
      originId: "device-A",
      targetNode: "n1",
      deps: h.deps,
    });

    expect(result.shardCount).toBe(1);
    expect(result.versionHash).toMatch(/^[0-9a-f]+$/);

    // One announce batch with FILE_CREATED + FILE_VERSION_ADDED, then one shard.
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]!.map((e) => e.type)).toEqual(["FILE_CREATED", "FILE_VERSION_ADDED"]);
    expect(h.posted).toHaveLength(1);
    // The posted blob is the packed nonce||ciphertext, not the 4 plaintext bytes.
    expect(h.posted[0]!.data.length).toBeGreaterThan(4);
    // The FEK was persisted for the file id the events reference.
    expect(h.keys.has(result.fileId)).toBe(true);
  });

  it("resumes without re-posting already-completed shards", async () => {
    const h = harness();
    // Pre-seed a partially complete record: shard 0 done, shard 1 outstanding.
    const fileId = "file-1";
    h.deps.getProgress = async () => ({
      transferId: `${fileId}:1`,
      fileId,
      versionNumber: 1,
      targetNode: "n1",
      totalShards: 2,
      versionHash: "hash",
      encryptedName: "enc",
      announced: true,
      completedShards: [0],
      shardSizeBytes: 2,
      createdAt: "x",
      updatedAt: "x",
    });
    // FEKs are 32 bytes (AES-256); the encrypt path rejects any other length.
    h.deps.getFileKey = async () => new Uint8Array(32).fill(9);

    const result = await uploadFile({
      source: source([1, 2, 3, 4]),
      originId: "device-A",
      targetNode: "n1",
      fileId,
      versionNumber: 1,
      deps: h.deps,
    });

    expect(result.resumed).toBe(true);
    // Only the outstanding shard is re-posted, and no announce batch is emitted.
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.shardIndex).toBe(1);
    expect(h.batches).toHaveLength(0);
  });
});
