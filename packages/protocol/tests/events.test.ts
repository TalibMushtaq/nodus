import { describe, expect, it } from "vitest";
import {
  EventTypes,
  EventTypeSchema,
  EventPayloadSchema,
  validateEventPayload,
  toProtocolFileId,
} from "../src/index.js";

describe("event type coercion", () => {
  it("accepts canonical event type literals", () => {
    expect(EventTypeSchema.parse("FILE_CREATED")).toBe("FILE_CREATED");
    expect(EventTypeSchema.parse("TOMBSTONE_CREATED")).toBe("TOMBSTONE_CREATED");
  });

  it("rejects a non-canonical event type", () => {
    expect(EventTypeSchema.safeParse("NOT_AN_EVENT").success).toBe(false);
  });

  it("exposes every canonical event type in the enum", () => {
    expect(EventTypes.FILE_CREATED).toBe("FILE_CREATED");
    expect(EventTypes.FILE_DELETED).toBe("FILE_DELETED");
    expect(EventTypes.FILE_VERSION_ADDED).toBe("FILE_VERSION_ADDED");
    expect(EventTypes.FILE_MODIFIED).toBe("FILE_MODIFIED");
    expect(EventTypes.DEVICE_REVOKED).toBe("DEVICE_REVOKED");
    expect(EventTypes.TOMBSTONE_CREATED).toBe("TOMBSTONE_CREATED");
    expect(EventTypes.FOLDER_CREATED).toBe("FOLDER_CREATED");
    expect(EventTypes.FOLDER_DELETED).toBe("FOLDER_DELETED");
  });
});

describe("event envelope ordering fields", () => {
  it("requires origin_id and origin_sequence for cursor-based ordering", () => {
    // origin_sequence missing → reject (this is the field that makes ordering
    // possible per §18)
    const partial = {
      event_id: "evt-1",
      origin_id: "node-1",
      type: "FILE_CREATED",
      payload: { file_id: "f1" },
      timestamp: new Date().toISOString(),
    };
    expect(EventPayloadSchema.safeParse(partial).success).toBe(false);
  });

  it("validates a fully-formed event with correct per-type payload", () => {
    const evt = {
      event_id: "evt-1",
      origin_id: "node-1",
      origin_sequence: 5,
      type: "FILE_VERSION_ADDED",
      payload: {
        file_id: "f1",
        version_number: 2,
        shard_count: 3,
        version_hash: "a".repeat(64),
      },
      timestamp: new Date().toISOString(),
    };
    expect(EventPayloadSchema.safeParse(evt).success).toBe(true);
  });

  it("validates a FILE_VERSION_ADDED payload with parent_version_id and conflict_status", () => {
    const evt = {
      event_id: "evt-2",
      origin_id: "node-1",
      origin_sequence: 6,
      type: "FILE_VERSION_ADDED",
      payload: {
        file_id: "f1",
        version_number: 3,
        parent_version_id: 2,
        conflict_status: "flagged",
        shard_count: 3,
        version_hash: "b".repeat(64),
      },
      timestamp: new Date().toISOString(),
    };
    expect(EventPayloadSchema.safeParse(evt).success).toBe(true);
  });
});

describe("validateEventPayload", () => {
  it("accepts a valid FILE_VERSION_ADDED payload", () => {
    const result = validateEventPayload("FILE_VERSION_ADDED", {
      file_id: "f1",
      version_number: 2,
      shard_count: 3,
      version_hash: "a".repeat(64),
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a FILE_VERSION_ADDED payload missing required fields", () => {
    const result = validateEventPayload("FILE_VERSION_ADDED", {
      file_id: "f1",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown event type", () => {
    const result = validateEventPayload(
      "BOGUS" as unknown as (typeof EventTypes)["FILE_CREATED"],
      {},
    );
    expect(result.ok).toBe(false);
  });
});

describe("toProtocolFileId mapping helper", () => {
  it("casts a string to the protocol branded FileId", () => {
    const id = toProtocolFileId("file-123");
    expect(id).toBe("file-123");
  });
});
