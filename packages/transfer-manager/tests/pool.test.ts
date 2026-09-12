import { describe, expect, it } from "vitest";
import {
  ConcurrencyPool,
  makeConfig,
  type ShardTransferRequest,
  type TransferPath,
} from "../src/index.js";

function makeRequest(i: number): ShardTransferRequest {
  return {
    transferId: `t${i}`,
    fileId: "f1",
    versionNumber: 1,
    shardIndex: i,
    data: new Uint8Array([i]),
    hash: "hash",
    targetNode: "node-1",
  };
}

describe("ConcurrencyPool", () => {
  it("never runs more transfers than maxConcurrency", async () => {
    let peak = 0;
    let running = 0;
    const pool = new ConcurrencyPool(
      makeConfig({ maxConcurrency: 2, backoffBaseMs: 0, backoffJitterMs: 0 }),
      {
        get: () => undefined,
        set: () => {},
        evict: () => {},
      },
      async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return { success: true, path: "relay_signaling" as TransferPath, transferId: "t", durationMs: 5, bytesTransferred: 1 };
      },
    );

    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => pool.submit(makeRequest(i))));

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
    expect(results.every((r) => r.success)).toBe(true);
    expect(pool.activeCount).toBe(0);
    expect(pool.queuedCount).toBe(0);
  });

  it("resolves a failed result when every path throws", async () => {
    const pool = new ConcurrencyPool(
      makeConfig({ maxConcurrency: 1, backoffBaseMs: 0, backoffJitterMs: 0, maxRetriesPerStage: 0 }),
      { get: () => undefined, set: () => {}, evict: () => {} },
      async () => {
        throw new Error("boom");
      },
    );

    // A throwing path advances the chain rather than rejecting the transfer,
    // so an all-throwing chain resolves to the last failure.
    const result = await pool.submit(makeRequest(1));
    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
    expect(pool.activeCount).toBe(0);
  });
});