import { describe, expect, it, vi } from "vitest";
import {
  executeTransfer,
  makeConfig,
  type ShardTransferRequest,
  type TransferPath,
} from "../src/index.js";

const FAST_CONFIG = makeConfig({
  backoffBaseMs: 0,
  backoffJitterMs: 0,
  maxRetriesPerStage: 1,
});

function makeRequest(overrides?: Partial<ShardTransferRequest>): ShardTransferRequest {
  return {
    transferId: "t1",
    fileId: "f1",
    versionNumber: 1,
    shardIndex: 0,
    data: new Uint8Array([1, 2, 3]),
    hash: "hash",
    targetNode: "node-1",
    ...overrides,
  };
}

class FakeCache {
  entries = new Map<string, { path: TransferPath; lastSuccessAt: number }>();
  get(nodeId: string) {
    return this.entries.get(nodeId);
  }
  set(nodeId: string, path: TransferPath) {
    this.entries.set(nodeId, { path, lastSuccessAt: Date.now() });
  }
  evict(nodeId: string) {
    this.entries.delete(nodeId);
  }
}

describe("executeTransfer", () => {
  it("tries the cached path first and succeeds via it", async () => {
    const cache = new FakeCache();
    cache.entries.set("node-1", { path: "relay_signaling", lastSuccessAt: Date.now() });
    const seen: TransferPath[] = [];
    const attemptPath = async (_req: ShardTransferRequest, path: TransferPath) => {
      seen.push(path);
      return { success: true, path, transferId: "t1", durationMs: 1, bytesTransferred: 3 };
    };

    const result = await executeTransfer(makeRequest(), FAST_CONFIG, cache, attemptPath);

    expect(result.success).toBe(true);
    expect(seen).toEqual(["relay_signaling"]);
  });

  it("caches a successful local_signaling success", async () => {
    const cache = new FakeCache();
    const attemptPath = async (_req: ShardTransferRequest, path: TransferPath) => ({
      success: true,
      path,
      transferId: "t1",
      durationMs: 1,
      bytesTransferred: 3,
    });

    await executeTransfer(makeRequest(), FAST_CONFIG, cache, attemptPath);

    expect(cache.entries.get("node-1")?.path).toBe("local_signaling");
  });

  it("evicts a cached path on failure and never retries it", async () => {
    const cache = new FakeCache();
    cache.entries.set("node-1", { path: "local_signaling", lastSuccessAt: Date.now() });
    const seen: TransferPath[] = [];
    const attemptPath = async (_req: ShardTransferRequest, path: TransferPath) => {
      seen.push(path);
      return {
        success: false,
        path,
        transferId: "t1",
        durationMs: 1,
        bytesTransferred: 0,
        error: "fail",
      };
    };

    await executeTransfer(makeRequest(), FAST_CONFIG, cache, attemptPath);

    expect(seen.filter((p) => p === "local_signaling")).toHaveLength(1);
    expect(cache.entries.has("node-1")).toBe(false);
  });

  it("falls through the chain in order until a path succeeds", async () => {
    const cache = new FakeCache();
    const seen: TransferPath[] = [];
    const attemptPath = async (_req: ShardTransferRequest, path: TransferPath) => {
      seen.push(path);
      const ok = path === "relay_signaling";
      return { success: ok, path, transferId: "t1", durationMs: 1, bytesTransferred: ok ? 3 : 0 };
    };

    const result = await executeTransfer(makeRequest(), FAST_CONFIG, cache, attemptPath);

    expect(result.success).toBe(true);
    // maxRetriesPerStage=1 → local_signaling attempted twice before relay
    expect(seen).toEqual(["local_signaling", "local_signaling", "relay_signaling"]);
    expect(cache.entries.get("node-1")?.path).toBe("relay_signaling");
  });

  it("returns the last failure when every path is exhausted", async () => {
    const attemptPath = async (_req: ShardTransferRequest, path: TransferPath) => ({
      success: false,
      path,
      transferId: "t1",
      durationMs: 1,
      bytesTransferred: 0,
      error: "down",
    });

    const result = await executeTransfer(makeRequest(), FAST_CONFIG, new FakeCache(), attemptPath);

    expect(result.success).toBe(false);
    expect(result.error).toBe("down");
  });

  it("retries per stage up to maxRetriesPerStage", async () => {
    const attemptPath = vi.fn(async (_req: ShardTransferRequest, path: TransferPath) => ({
      success: false,
      path,
      transferId: "t1",
      durationMs: 1,
      bytesTransferred: 0,
      error: "down",
    }));

    await executeTransfer(
      makeRequest(),
      makeConfig({ backoffBaseMs: 0, backoffJitterMs: 0, maxRetriesPerStage: 2 }),
      new FakeCache(),
      attemptPath,
    );

    // 2 retries + initial attempt = 3 calls per path, for all 4 paths
    expect(attemptPath).toHaveBeenCalledTimes(12);
  });
});