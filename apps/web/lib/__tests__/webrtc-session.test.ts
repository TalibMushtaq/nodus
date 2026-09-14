import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the transport primitives so the session can be exercised without a real
// RTCPeerConnection. The session only uses createDataChannel / createOffer /
// setRemoteDescription / close and the two helper functions.
const { sendShardMock } = vi.hoisted(() => ({ sendShardMock: vi.fn() }));

vi.mock("@repo/webrtc-transport", () => {
  class FakeDataChannel {
    readyState = "open";
    addEventListener() {
      // no-op: the session only needs the channel to look open
    }
  }
  class FakePeerConnection {
    createDataChannel() {
      return new FakeDataChannel();
    }
    async createOffer() {
      return { sdp: "offer" };
    }
    async setRemoteDescription() {
      // no-op
    }
    async addIceCandidate() {
      // no-op
    }
    close() {
      // no-op
    }
  }
  return {
    NodusRTCPeerConnection: FakePeerConnection,
    sendShard: sendShardMock,
    waitForChannelOpen: async () => undefined,
  };
});

import { PersistentWebRtcSession, WebRtcSessionCache } from "../transfer/webrtc-session";

function fakeChannel() {
  let answerCb: ((sdp: string) => void) | null = null;
  return {
    async sendOffer() {
      answerCb?.("answer-sdp");
    },
    async sendAnswer() {
      // not used by the offerer
    },
    async sendIceCandidate() {
      // no-op
    },
    close() {
      // no-op
    },
    get onAnswer() {
      return answerCb;
    },
    set onAnswer(cb: ((sdp: string) => void) | null) {
      answerCb = cb;
    },
    onIceCandidate: null,
  };
}

function shardRequest(shardIndex: number) {
  return {
    transferId: "t-1",
    fileId: "file-1",
    versionNumber: 1,
    shardIndex,
    data: new Uint8Array([shardIndex]),
    hash: "a".repeat(64),
    targetNode: "node-1",
    sourceDevice: "dev-1",
  };
}

function verifiedAck(shardIndex: number) {
  return {
    status: "verified",
    file_id: "file-1",
    version_number: 1,
    shard_index: shardIndex,
    transfer_id: "t-1",
  };
}

beforeEach(() => {
  sendShardMock.mockReset();
});

describe("PersistentWebRtcSession", () => {
  it("serializes concurrent shard sends over one data channel", async () => {
    const order: string[] = [];
    sendShardMock.mockImplementation(async (_channel, opts: { shardIndex: number }) => {
      order.push(`start:${opts.shardIndex}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`end:${opts.shardIndex}`);
      return verifiedAck(opts.shardIndex);
    });

    const session = new PersistentWebRtcSession({ createChannel: fakeChannel });
    await Promise.all([session.send(shardRequest(0)), session.send(shardRequest(1))]);

    // The frame protocol has no shard id on the wire, so sends must not overlap.
    expect(order).toEqual(["start:0", "end:0", "start:1", "end:1"]);
    expect(sendShardMock).toHaveBeenCalledTimes(2);
  });

  it("becomes unhealthy after a failed send", async () => {
    sendShardMock.mockRejectedValueOnce(new Error("boom"));
    const session = new PersistentWebRtcSession({ createChannel: fakeChannel });

    await expect(session.send(shardRequest(0))).rejects.toThrow("boom");
    // Let the tail's rejection handler mark the session dead.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.healthy).toBe(false);
  });

  it("tracks whether negotiation ever succeeded", async () => {
    sendShardMock.mockResolvedValueOnce(verifiedAck(0));
    const session = new PersistentWebRtcSession({ createChannel: fakeChannel });
    await session.send(shardRequest(0));
    expect(session.everConnected).toBe(true);
  });
});

describe("WebRtcSessionCache", () => {
  it("reuses a healthy session and recreates after eviction", () => {
    const cache = new WebRtcSessionCache();
    const deps = () => ({ createChannel: fakeChannel });

    const first = cache.get("local_signaling:node-1", deps);
    expect(cache.get("local_signaling:node-1", deps)).toBe(first);

    cache.evict("local_signaling:node-1");
    const second = cache.get("local_signaling:node-1", deps);
    expect(second).not.toBe(first);
  });

  it("keys sessions by path and node", () => {
    const cache = new WebRtcSessionCache();
    const deps = () => ({ createChannel: fakeChannel });
    expect(cache.get("local_signaling:node-1", deps)).not.toBe(
      cache.get("relay_signaling:node-1", deps),
    );
  });

  it("cools a key down after a negotiation failure, then retries", () => {
    vi.useFakeTimers();
    try {
      const cache = new WebRtcSessionCache(1000);
      expect(cache.isAvailable("k")).toBe(true);

      cache.markUnavailable("k");
      // The remaining shards must skip the path instead of retrying the timeout.
      expect(cache.isAvailable("k")).toBe(false);

      vi.advanceTimersByTime(1001);
      expect(cache.isAvailable("k")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
