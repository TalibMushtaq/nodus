import { describe, expect, it, vi } from "vitest";
import {
  InMemoryPathCache,
  MemoryLocalQueue,
  TransferManager,
  makeConfig,
  type ShardTransferRequest,
  type TransferPath,
  type TransferResult,
} from "../src/index.js";

function makeRequest(i = 0): ShardTransferRequest {
  return {
    transferId: `t${i}`,
    fileId: "f1",
    versionNumber: 1,
    shardIndex: i,
    data: new Uint8Array([1]),
    hash: "hash",
    targetNode: "node-1",
  };
}

describe("InMemoryPathCache", () => {
  it("stores and returns entries, evicts on demand", () => {
    const cache = new InMemoryPathCache();
    expect(cache.get("node-1")).toBeUndefined();
    cache.set("node-1", "local_signaling");
    expect(cache.get("node-1")?.path).toBe("local_signaling");
    expect(cache.get("node-1")?.lastSuccessAt).toBeGreaterThan(0);
    cache.evict("node-1");
    expect(cache.get("node-1")).toBeUndefined();
  });
});

describe("MemoryLocalQueue", () => {
  it("enqueues/dequeues in FIFO order and can remove and peek", () => {
    const q = new MemoryLocalQueue();
    const item = (id: string) => ({
      transferId: id,
      fileId: "f",
      versionNumber: 1,
      shardIndex: 0,
      data: new Uint8Array(0),
      hash: "h",
      targetNode: "node-1",
      enqueuedAt: Date.now(),
      retryCount: 0,
    });
    q.enqueue(item("a"));
    q.enqueue(item("b"));
    expect(q.size).toBe(2);
    expect(q.peek()?.transferId).toBe("a");
    q.remove("a");
    expect(q.dequeue()?.transferId).toBe("b");
    expect(q.size).toBe(0);
  });

  it("notifies listeners on connectivity restore", () => {
    const q = new MemoryLocalQueue();
    const cb = vi.fn();
    q.onConnectivityRestored(cb);
    q.notifyConnectivityRestored();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("TransferManager", () => {
  it("falls back and reports failure when every path is down", async () => {
    const attemptPath = async (_req: ShardTransferRequest, path: TransferPath): Promise<TransferResult> => ({
      success: false,
      path,
      transferId: "t0",
      durationMs: 1,
      bytesTransferred: 0,
      error: "down",
    });

    const manager = new TransferManager(
      attemptPath,
      makeConfig({ backoffBaseMs: 0, backoffJitterMs: 0 }),
    );

    const result = await manager.uploadShard(makeRequest(0));
    expect(result.success).toBe(false);
    expect(result.error).toBe("down");
    expect(manager.activeCount).toBe(0);
  });

  it("drains the local queue on connectivity restore", async () => {
    let healthy = false;
    let resolvedTransferId: string | undefined;

    const attemptPath = async (req: ShardTransferRequest, path: TransferPath): Promise<TransferResult> => {
      const ok = healthy;
      if (ok) resolvedTransferId = req.transferId;
      return {
        success: ok,
        path,
        transferId: req.transferId,
        durationMs: 1,
        bytesTransferred: ok ? req.data.length : 0,
        ...(ok ? {} : { error: "down" }),
      };
    };

    const manager = new TransferManager(
      attemptPath,
      makeConfig({ backoffBaseMs: 0, backoffJitterMs: 0 }),
    );

    // While unhealthy, transfers fail and get queued for Path D.
    await manager.uploadShard(makeRequest(0));
    expect(manager.queuedCount).toBe(0);

    manager.enqueue(makeRequest(1));

    // Connectivity returns: the queued item should be redriven and succeed.
    healthy = true;
    manager.notifyConnectivityRestored();

    await vi.waitFor(() => expect(resolvedTransferId).toBe("t1"));
  });
});