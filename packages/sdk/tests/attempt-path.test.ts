import { describe, expect, it, vi } from "vitest";
import type { LocalQueue, QueueItem, ShardTransferRequest } from "@repo/transfer-manager";

import { createAttemptPath } from "../src/transfer/attempt-path.js";

function request(): ShardTransferRequest {
  return {
    transferId: "t1",
    fileId: "f1",
    versionNumber: 1,
    shardIndex: 0,
    data: new Uint8Array([1, 2, 3]),
    hash: "abc",
    targetNode: "n1" as never,
  };
}

function fakeQueue(): LocalQueue & { items: QueueItem[] } {
  const items: QueueItem[] = [];
  return {
    items,
    enqueue: (item) => void items.push(item),
    dequeue: () => items.shift(),
    peek: () => items[0],
    remove: (id) => {
      const i = items.findIndex((x) => x.transferId === id);
      if (i >= 0) items.splice(i, 1);
    },
    onConnectivityRestored: () => undefined,
    notifyConnectivityRestored: () => undefined,
    get size() {
      return items.length;
    },
  };
}

/** Base deps with capability predicates stubbed; overrides per test. */
function deps(overrides: Partial<Parameters<typeof createAttemptPath>[0]> = {}) {
  return {
    postShard: vi.fn(async () => ({ buffer_id: "b", status: "RELAY_BUFFERED" })),
    localQueue: fakeQueue(),
    deviceId: "d1",
    resolveLocalHost: vi.fn(async () => null),
    canAttemptLocalPath: () => false,
    canAttemptRelaySignaling: () => false,
    ...overrides,
  };
}

describe("shared attempt path", () => {
  it("posts to the Relay buffer for buffer_relay", async () => {
    const d = deps();
    const attempt = createAttemptPath(d);

    const result = await attempt(request(), "buffer_relay");

    expect(result.success).toBe(true);
    expect(result.path).toBe("buffer_relay");
    expect(d.postShard).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: "f1",
        shardIndex: 0,
        targetNode: "n1",
        size: 3,
        sourceDevice: undefined,
      }),
    );
  });

  it("enqueues for local_queue", async () => {
    const d = deps();
    const attempt = createAttemptPath(d);

    const result = await attempt(request(), "local_queue");

    expect(result.success).toBe(true);
    expect(d.localQueue.items).toHaveLength(1);
    expect(d.localQueue.items[0]!.transferId).toBe("t1");
  });

  it("throws on direct paths when the platform cannot attempt them", async () => {
    const attempt = createAttemptPath(deps());
    await expect(attempt(request(), "local_signaling")).rejects.toThrow(/local signaling unavailable/);
    await expect(attempt(request(), "relay_signaling")).rejects.toThrow(/WebRTC unavailable/);
  });

  it("throws when Path A has no trusted local host", async () => {
    // Capabilities allow Path A, but the node is not in the trusted cache, so
    // the host lookup fails and the chain should fall through to Path C.
    const attempt = createAttemptPath(deps({ canAttemptLocalPath: () => true }));
    await expect(attempt(request(), "local_signaling")).rejects.toThrow(/no trusted local host/);
  });

  it("skips direct paths for an offline node before any negotiation", async () => {
    // Even with capabilities and a trusted host, an offline node must fail fast
    // so the chain reaches the Relay buffer without a WebRTC timeout.
    const attempt = createAttemptPath(
      deps({
        canAttemptLocalPath: () => true,
        canAttemptRelaySignaling: () => true,
        isNodeOnline: () => false,
        resolveLocalHost: vi.fn(async () => "192.168.1.10"),
      }),
    );
    await expect(attempt(request(), "local_signaling")).rejects.toThrow(/offline/);
    await expect(attempt(request(), "relay_signaling")).rejects.toThrow(/offline/);
  });
});
