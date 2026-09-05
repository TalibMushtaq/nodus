import { describe, expect, it } from "vitest";
import {
  parseMessage,
  MessageTypes,
  CURRENT_SCHEMA_VERSION,
  type MessageId,
} from "../src/index.js";

const msgId = "msg-1" as MessageId;

function envelopePayload(type: string, payload: unknown) {
  return {
    type,
    schema_version: CURRENT_SCHEMA_VERSION,
    message_id: msgId,
    payload,
  };
}

describe("parseMessage", () => {
  it("validates a heartbeat round-trip", () => {
    const raw = envelopePayload(MessageTypes.HEARTBEAT, {
      id: "node-1",
      timestamp: new Date().toISOString(),
    });

    const result = parseMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe("heartbeat");
      expect(result.message.payload).toMatchObject({ id: "node-1" });
    }
  });

  it("validates a shard_upload round-trip", () => {
    const raw = envelopePayload(MessageTypes.SHARD_UPLOAD, {
      file_id: "file-42",
      version_number: 1,
      shard_index: 0,
      hash: "a".repeat(64),
      size: 1024,
      transfer_id: "transfer-1",
    });

    const result = parseMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.payload).toMatchObject({ shard_index: 0 });
    }
  });

  it("rejects a missing payload field for the message type", () => {
    const raw = envelopePayload(MessageTypes.SHARD_UPLOAD, {
      file_id: "file-42",
      // shard_index missing
      hash: "a".repeat(64),
      size: 1024,
      transfer_id: "transfer-1",
    });

    const result = parseMessage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
    }
  });

  it("rejects an unknown message type without throwing", () => {
    const raw = envelopePayload("bogus_type", { anything: 1 });
    const result = parseMessage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unknown_message_type");
      // correlation is the message_id so callers can reply to the right id
      expect(result.error.correlationId).toBe(msgId);
    }
  });

  it("rejects a malformed envelope (missing message_id)", () => {
    const raw = {
      type: MessageTypes.HEARTBEAT,
      schema_version: CURRENT_SCHEMA_VERSION,
      // message_id missing
    };
    const result = parseMessage(raw);
    expect(result.ok).toBe(false);
  });

  it("rejects an incompatible schema version (major mismatch)", () => {
    const raw = envelopePayload(MessageTypes.HEARTBEAT, {
      id: "node-1",
      timestamp: new Date().toISOString(),
    });
    raw.schema_version = "2.0";
    const result = parseMessage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("incompatible_version");
    }
  });

  it("rejects a malformed schema_version string", () => {
    const raw = envelopePayload(MessageTypes.HEARTBEAT, {
      id: "node-1",
      timestamp: new Date().toISOString(),
    });
    raw.schema_version = "v1";
    const result = parseMessage(raw);
    expect(result.ok).toBe(false);
  });
});
