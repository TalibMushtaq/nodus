import { describe, expect, it, vi } from "vitest";
import type { LocalQueue, QueueItem, ShardTransferRequest } from "@repo/transfer-manager";

import { createBrowserAttemptPath } from "../transfer/attempt-path";
import { canAttemptLocalPath, canAttemptRelaySignaling, getWebRtcCapabilities } from "../local-network";

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

describe("local-network capability detection", () => {
  it("reports no WebRTC in jsdom and blocks the local path", () => {
    const caps = getWebRtcCapabilities();
    expect(caps.peerConnection).toBe(false);
    expect(canAttemptLocalPath(caps)).toBe(false);
    expect(canAttemptRelaySignaling(caps)).toBe(false);
  });
});

describe("browser attempt path", () => {
  it("uploads via the Relay buffer for buffer_relay", async () => {
    const postShard = vi.fn(async () => ({ buffer_id: "b", status: "RELAY_BUFFERED" }));
    const attempt = createBrowserAttemptPath({ postShard, localQueue: fakeQueue(), deviceId: "d1" });

    const result = await attempt(request(), "buffer_relay");

    expect(result.success).toBe(true);
    expect(result.path).toBe("buffer_relay");
    expect(postShard).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "f1", shardIndex: 0, targetNode: "n1", size: 3, sourceDevice: undefined }),
    );
  });

  it("enqueues for local_queue", async () => {
    const queue = fakeQueue();
    const attempt = createBrowserAttemptPath({ postShard: vi.fn(), localQueue: queue, deviceId: "d1" });

    const result = await attempt(request(), "local_queue");

    expect(result.success).toBe(true);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.transferId).toBe("t1");
  });

  it("throws for direct paths when WebRTC is unavailable so the chain falls through", async () => {
    const attempt = createBrowserAttemptPath({ postShard: vi.fn(), localQueue: fakeQueue(), deviceId: "d1" });
    await expect(attempt(request(), "local_signaling")).rejects.toThrow(/local signaling unavailable/);
    await expect(attempt(request(), "relay_signaling")).rejects.toThrow(/WebRTC unavailable/);
  });
});
