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
        version_number: 1,
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
        version_number: 1,
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
        version_number: 1,
        shard_index: 2,
        buffer_id: "buf-1",
        fetch_token: "tok-123",
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
        snapshot_sequence: 3,
        total_chunks: 10,
        content_hash: "d".repeat(64),
        signature: "sig".repeat(16),
        data_schema_version: "1.0",
        cursors: [{ origin_id: "node-1", sequence: 42 }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("snapshot_begin rejects missing cursor map", () => {
    const r = parseMessage(
      msg(MessageTypes.SNAPSHOT_BEGIN, {
        snapshot_id: "snap-1",
        node_id: "node-1",
        snapshot_sequence: 3,
        total_chunks: 10,
        content_hash: "d".repeat(64),
        signature: "sig".repeat(16),
        data_schema_version: "1.0",
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("snapshot_chunk carries typed homogeneous records", () => {
    const r = parseMessage(
      msg(MessageTypes.SNAPSHOT_CHUNK, {
        snapshot_id: "snap-1",
        chunk_index: 0,
        record_type: "file_version",
        records: [
          {
            file_id: "file-1",
            version_number: 1,
            parent_version_id: null,
            conflict_status: "none",
            version_hash: "b".repeat(64),
            shard_count: 1,
            encrypted_name: "photo.jpg",
            parent_folder_id: null,
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("snapshot_chunk rejects a chunk exceeding the 1000-record cap", () => {
    const records = Array.from({ length: 1001 }, (_, i) => ({
      file_id: `file-${i}`,
      version_number: 1,
      parent_version_id: null,
      version_hash: "h",
      shard_count: 1,
    }));
    const r = parseMessage(
      msg(MessageTypes.SNAPSHOT_CHUNK, {
        snapshot_id: "snap-1",
        chunk_index: 0,
        record_type: "file_version",
        records,
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("snapshot_chunk tombstone records", () => {
    const r = parseMessage(
      msg(MessageTypes.SNAPSHOT_CHUNK, {
        snapshot_id: "snap-1",
        chunk_index: 1,
        record_type: "tombstone",
        records: [
          {
            entity_type: "file",
            entity_id: "file-deleted-1",
            deleted_at: "2026-09-01T00:00:00Z",
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("rebuild_required", () => {
    const r = parseMessage(
      msg(MessageTypes.REBUILD_REQUIRED, {
        node_id: "node-1",
        reason: "restore",
        expected_content_hash: "c".repeat(64),
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

  it("node_auth_challenge", () => {
    const r = parseMessage(
      msg(MessageTypes.NODE_AUTH_CHALLENGE, {
        nonce: "a".repeat(64),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("node_auth_response", () => {
    const r = parseMessage(
      msg(MessageTypes.NODE_AUTH_RESPONSE, {
        node_id: "node-1",
        signature: "sig123",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("node_auth_result", () => {
    const r = parseMessage(
      msg(MessageTypes.NODE_AUTH_RESULT, {
        status: "ok",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("batch_ack", () => {
    const r = parseMessage(
      msg(MessageTypes.BATCH_ACK, {
        batch_id: "batch-1",
        applied_event_ids: ["evt-1", "evt-2"],
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

  // ── Phase 11: pairing_token_push is the only new WS-registered message ──

  it("pairing_token_push", () => {
    const r = parseMessage(
      msg(MessageTypes.PAIRING_TOKEN_PUSH, {
        node_id: "node-1",
        token: "tok-123",
        device_public_key: "a".repeat(64),
        expires_at: "2026-09-06T12:00:00Z",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("pairing_token_push rejects non-datetime expires_at", () => {
    const r = parseMessage(
      msg(MessageTypes.PAIRING_TOKEN_PUSH, {
        node_id: "node-1",
        token: "tok-123",
        device_public_key: "a".repeat(64),
        expires_at: "not-a-date",
      }),
    );
    expect(r.ok).toBe(false);
  });
});

// ── Phase 11: HTTP-only payloads validate directly (not via WS dispatch) ──

import {
  LocalAuthResultPayloadSchema,
  LocalChallengePayloadSchema,
  LocalChallengeResponsePayloadSchema,
  LocalDiscoveryAdvertisementSchema,
  LocalDiscoveryPongSchema,
  PairingConfirmPayloadSchema,
  PairingRejectPayloadSchema,
  PairingRequestPayloadSchema,
} from "../src/index.js";

describe("phase 11 local-HTTP contracts validate directly", () => {
  it("local discovery advertisement", () => {
    const ok = LocalDiscoveryAdvertisementSchema.safeParse({
      node_id: "node-1",
      public_key: "a".repeat(64),
      schema_version: "1.0",
      pk_fp: "deadbeef",
    });
    expect(ok.success).toBe(true);
  });

  it("local discovery pong is a strict advertisement", () => {
    // strict() rejects unknown keys — keeps node/client contract tight.
    const ok = LocalDiscoveryPongSchema.safeParse({
      node_id: "node-1",
      public_key: "a".repeat(64),
      schema_version: "1.0",
      extra: "nope",
    });
    expect(ok.success).toBe(false);
  });

  it("local challenge + response round-trip", () => {
    const challenge = LocalChallengePayloadSchema.parse({
      nonce: "0123456789abcdef0123456789abcdef",
      ttl_seconds: 30,
    });
    const resp = LocalChallengeResponsePayloadSchema.parse({
      device_id: "dev-1",
      nonce: "0123456789abcdef0123456789abcdef",
      signature: "sig".repeat(16),
    });
    const result = LocalAuthResultPayloadSchema.parse({
      status: "ok",
      node_id: "node-1",
    });
    expect(challenge.nonce).toHaveLength(32);
    expect(resp.nonce).toHaveLength(32);
    expect(resp.signature).toBe("sig".repeat(16));
    expect(result.status).toBe("ok");
  });

  it("pairing request/confirm/reject shapes", () => {
    const req = PairingRequestPayloadSchema.parse({
      node_id: "node-1",
      token: "tok-123",
      device_public_key: "a".repeat(64),
      device_id: "dev-1",
    });
    const confirm = PairingConfirmPayloadSchema.parse({
      node_id: "node-1",
      account_id: "acc-1",
      device_id: "dev-1",
      device_public_key: "a".repeat(64),
    });
    const reject = PairingRejectPayloadSchema.parse({
      node_id: "node-1",
      reason: "token_consumed",
      message: "already used",
    });
    expect(req.token).toBe("tok-123");
    expect(confirm.device_public_key).toBe("a".repeat(64));
    expect(reject.reason).toBe("token_consumed");
  });

  it("pairing request requires device_public_key", () => {
    const ok = PairingRequestPayloadSchema.safeParse({
      node_id: "node-1",
      token: "tok-123",
    });
    expect(ok.success).toBe(false);
  });
});

