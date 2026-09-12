import { describe, expect, it } from "vitest";
import { hashShard } from "@repo/core";
import type { EventPayload } from "@repo/protocol";

import type { ShardUpload } from "../buffer";
import type { UploadProgress } from "../upload-progress";
import { uploadFile } from "../uploader";
import type { UploadDeps } from "../uploader";

function makeDeps() {
  const order: string[] = [];
  const calls = {
    postShard: [] as ShardUpload[],
    events: [] as EventPayload[][],
  };
  const keys = new Map<string, Uint8Array>();
  const store = new Map<string, UploadProgress>();
  let seq = 0;

  const deps: UploadDeps = {
    postShard: async (dto) => {
      order.push(`post:${dto.shardIndex}`);
      calls.postShard.push(dto);
      return { buffer_id: `b-${dto.shardIndex}`, status: "RELAY_BUFFERED" };
    },
    sendEventBatch: async (events) => {
      order.push("events");
      calls.events.push(events);
      return { applied_event_ids: events.map((e) => e.event_id) };
    },
    allocateSequence: async () => (seq += 1),
    putFileKey: async (id, fek) => {
      order.push("putFileKey");
      keys.set(id, fek);
    },
    getFileKey: async (id) => keys.get(id),
    saveProgress: async (p) => {
      store.set(p.transferId, { ...p, completedShards: [...p.completedShards] });
    },
    getProgress: async (id, v) => store.get(`${id}:${v}`),
    markShardComplete: async (id, v, index) => {
      const p = store.get(`${id}:${v}`);
      if (p && !p.completedShards.includes(index)) p.completedShards.push(index);
    },
    clearProgress: async (id, v) => {
      store.delete(`${id}:${v}`);
    },
    publishEnvelopes: async () => {
      order.push("envelopes");
    },
  };

  return { deps, calls, order, keys, store };
}

// jsdom's Blob does not implement arrayBuffer(), so provide the minimal File
// surface the uploader uses (name/size/slice().arrayBuffer()).
function fakeFile(data: Uint8Array, name: string): File {
  return {
    name,
    size: data.length,
    slice: (start: number, end?: number) => ({
      arrayBuffer: async () => data.slice(start, end).buffer,
    }),
  } as unknown as File;
}

function seedProgress(store: Map<string, UploadProgress>, overrides: Partial<UploadProgress> = {}) {
  const progress: UploadProgress = {
    transferId: "file-1:1",
    fileId: "file-1",
    versionNumber: 1,
    targetNode: "n1",
    totalShards: 3,
    versionHash: "vh",
    encryptedName: "enc",
    announced: true,
    completedShards: [0],
    createdAt: "2026-09-12T00:00:00Z",
    updatedAt: "2026-09-12T00:00:00Z",
    ...overrides,
  };
  store.set(progress.transferId, progress);
}

describe("uploadFile", () => {
  it("emits events after persisting the FEK and before posting shards", async () => {
    const { deps, calls, order, keys } = makeDeps();
    const file = fakeFile(new Uint8Array(100), "quarterly.pdf");

    const result = await uploadFile({ file, originId: "device-A", targetNode: "n1", deps });

    expect(result.shardCount).toBe(1);
    expect(result.versionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]!.map((e) => e.type)).toEqual(["FILE_CREATED", "FILE_VERSION_ADDED"]);
    expect(calls.postShard).toHaveLength(1);
    // Ordering gate: key durable before the event that references the file, and
    // events before any shard the Relay would reject without the version row.
    expect(order.indexOf("putFileKey")).toBeLessThan(order.indexOf("events"));
    // Key envelopes are published after the file exists and before shards move.
    expect(order.indexOf("events")).toBeLessThan(order.indexOf("envelopes"));
    expect(order.indexOf("envelopes")).toBeLessThan(order.indexOf("post:0"));
    expect(keys.get(result.fileId)?.length).toBe(32);
  });

  it("posts shards whose hash matches the ciphertext", async () => {
    const { deps, calls } = makeDeps();
    const file = fakeFile(new Uint8Array(50), "a.bin");
    await uploadFile({ file, originId: "device-A", targetNode: "n1", deps });
    const shard = calls.postShard[0]!;
    expect(shard.hash).toBe(hashShard(shard.data));
    expect(shard.size).toBe(shard.data.length);
    expect(shard.targetNode).toBe("n1");
  });

  it("resumes only outstanding shards without re-announcing", async () => {
    const { deps, calls, order, keys, store } = makeDeps();
    keys.set("file-1", new Uint8Array(32));
    seedProgress(store, { announced: true, completedShards: [0] });
    const file = fakeFile(new Uint8Array(10), "a.bin");

    const result = await uploadFile({ file, originId: "device-A", targetNode: "n1", fileId: "file-1", deps });

    expect(result.resumed).toBe(true);
    expect(calls.events).toHaveLength(0);
    expect(calls.postShard.map((s) => s.shardIndex)).toEqual([1, 2]);
    // Envelopes are re-published on resume so a transient failure retries.
    expect(order).toContain("envelopes");
  });

  it("re-emits events when a resumed upload never announced them", async () => {
    const { deps, calls, keys, store } = makeDeps();
    keys.set("file-1", new Uint8Array(32));
    seedProgress(store, { announced: false });
    const file = fakeFile(new Uint8Array(10), "a.bin");

    await uploadFile({ file, originId: "device-A", targetNode: "n1", fileId: "file-1", deps });

    expect(calls.events).toHaveLength(1);
    expect(calls.postShard.map((s) => s.shardIndex)).toEqual([1, 2]);
  });

  it("aborts before emitting events when the FEK cannot be persisted", async () => {
    const { deps, calls } = makeDeps();
    deps.putFileKey = async () => {
      throw new Error("disk full");
    };
    const file = fakeFile(new Uint8Array(10), "a.bin");

    await expect(uploadFile({ file, originId: "device-A", targetNode: "n1", deps })).rejects.toThrow("disk full");
    expect(calls.events).toHaveLength(0);
    expect(calls.postShard).toHaveLength(0);
  });
});
