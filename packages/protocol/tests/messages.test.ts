import { describe, expect, it } from "vitest";
import {
  parseMessage,
  MessageTypes,
  CURRENT_SCHEMA_VERSION,
  type MessageId,
} from "../src/index.js";

const msgId = "msg-1" as MessageId;

function msg<T>(type: string, payload: T) {
  return {
    type,
    schema_version: CURRENT_SCHEMA_VERSION,
    message_id: msgId,
    payload,
  };
}

describe("message catalog round-trips", () => {
  it("register", () => {
    const r = parseMessage(
      msg(MessageTypes.REGISTER, {
        account_id: "acc-1",
        device_id: "dev-1",
        public_key: "0xabc123".repeat(8),
        capabilities: ["storage", "sync"],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("register rejects unknown platform capabilities value", () => {
    const r = parseMessage(
      msg(MessageTypes.REGISTER, {
        account_id: "acc-1",
        public_key: "x".repeat(64),
        capabilities: ["storage", "nonexistent_cap"],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("webrtc_offer carries opaque SDP", () => {
    const r = parseMessage(
      msg(MessageTypes.WEBRTC_OFFER, {
        from_peer: "dev-1",
        to_peer: "node-1",
        sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("webrtc_ice_candidate carries opaque candidate string", () => {
    const r = parseMessage(
      msg(MessageTypes.WEBRTC_ICE_CANDIDATE, {
        from_peer: "dev-1",
        to_peer: "node-1",
        candidate: "candidate:1 1 UDP 2122252543 192.168.1.5 54321 typ host",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("heartbeat minimal payload round-trips", () => {
    const r = parseMessage(
      msg(MessageTypes.HEARTBEAT, {
        id: "node-1",
        timestamp: new Date().toISOString(),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("shard_ack verified status", () => {
    const r = parseMessage(
      msg(MessageTypes.SHARD_ACK, {
        file_id: "file-1",
        shard_index: 0,
        status: "verified",
        transfer_id: "t-1",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("shard_ack failed status rejects invalid status value", () => {
    const r = parseMessage(
      msg(MessageTypes.SHARD_ACK, {
        file_id: "file-1",
        shard_index: 0,
        status: "bogus",
        transfer_id: "t-1",
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("pending_notify", () => {
    const r = parseMessage(
      msg(MessageTypes.PENDING_NOTIFY, {
        file_id: "file-1",
        shard_index: 2,
        buffer_id: "buf-1",
        from_device: "dev-7",
        hash: "b".repeat(64),
        size: 4096,
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("shard_fetch", () => {
    const r = parseMessage(
      msg(MessageTypes.SHARD_FETCH, {
        file_id: "file-1",
        shard_index: 3,
        transfer_id: "t-2",
        source: "relay_buffer",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("shard_delete", () => {
    const r = parseMessage(
      msg(MessageTypes.SHARD_DELETE, {
        file_id: "file-1",
        shard_index: 3,
        reason: "transferred",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("sync_hello carries per-origin cursors", () => {
    const r = parseMessage(
      msg(MessageTypes.SYNC_HELLO, {
        node_id: "node-1",
        cursors: [{ origin_id: "node-1", sequence: 42 }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("sync_status carries cursor counts", () => {
    const r = parseMessage(
      msg(MessageTypes.SYNC_STATUS, {
        node_id: "node-1",
        cursors: [{ origin_id: "relay", sequence: 100, known_count: 100 }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("event_batch", () => {
    const r = parseMessage(
      msg(MessageTypes.EVENT_BATCH, {
        events: [
          {
            event_id: "evt-1",
            origin_id: "node-1",
            origin_sequence: 1,
            type: "FILE_CREATED",
            payload: { file_id: "file-9" },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("event_batch rejects an event with a payload mismatching its type", () => {
    const r = parseMessage(
      msg(MessageTypes.EVENT_BATCH, {
        events: [
          {
            event_id: "evt-1",
            origin_id: "node-1",
            origin_sequence: 1,
            // DEVICE_REVOKED requires a different payload shape than FILE_*
            type: "FILE_CREATED",
            payload: { device_id: "dev-x" },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("reconcile", () => {
    const r = parseMessage(
      msg(MessageTypes.RECONCILE, {
        node_id: "node-1",
        content_hash: "c".repeat(64),
        checkpoint: 12,
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("snapshot_begin", () => {
    const r = parseMessage(
      msg(MessageTypes.SNAPSHOT_BEGIN, {
        snapshot_id: "snap-1",
        node_id: "node-1",
        sequence: 2048,
        total_chunks: 10,
        content_hash: "d".repeat(64),
        signature: "sig".repeat(16),
        data_schema_version: "1.0",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("snapshot_chunk", () => {
    const r = parseMessage(
      msg(MessageTypes.SNAPSHOT_CHUNK, {
        snapshot_id: "snap-1",
        chunk_index: 0,
        data: "YWJjZA==",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("snapshot_end", () => {
    const r = parseMessage(
      msg(MessageTypes.SNAPSHOT_END, {
        snapshot_id: "snap-1",
        final_hash: "e".repeat(64),
        signature: "sig".repeat(16),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("error message", () => {
    const r = parseMessage(
      msg(MessageTypes.ERROR, {
        correlation_id: "orig-1",
        error_code: "validation_error",
        error_message: "bad payload",
        retryable: false,
      }),
    );
    expect(r.ok).toBe(true);
  });
});
