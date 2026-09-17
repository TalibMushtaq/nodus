import { describe, expect, it } from "vitest";

import { toCatalogEntry, type RelayFile } from "../src/catalog/catalog.js";

function file(overrides: Partial<RelayFile> = {}): RelayFile {
  return {
    file_id: "f1",
    parent_folder_id: null,
    encrypted_name: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    versions: [],
    locations: [],
    ...overrides,
  };
}

describe("toCatalogEntry", () => {
  it("picks the latest version and rolls its locations into a status", () => {
    const entry = toCatalogEntry(
      file({
        versions: [
          { version_number: 1, shard_count: 1, version_hash: "v1", conflict_status: "none", created_at: "x" },
          { version_number: 2, shard_count: 2, version_hash: "v2", conflict_status: "none", created_at: "x" },
        ],
        locations: [
          { version_number: 1, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: null, size_bytes: null },
          { version_number: 2, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: null, size_bytes: null },
          { version_number: 2, shard_index: 1, node_id: "n1", status: "NODE_STORED", hash: null, size_bytes: null },
        ],
      }),
    );

    expect(entry.latest_version_number).toBe(2);
    expect(entry.shard_count).toBe(2);
    expect(entry.version_hash).toBe("v2");
    expect(entry.storage_status).toBe("stored");
  });

  it("reports buffered when any shard is still in the Relay buffer", () => {
    const entry = toCatalogEntry(
      file({
        versions: [{ version_number: 1, shard_count: 2, version_hash: "v", conflict_status: "none", created_at: "x" }],
        locations: [
          { version_number: 1, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: null, size_bytes: null },
          { version_number: 1, shard_index: 1, node_id: "n1", status: "RELAY_BUFFERED", hash: null, size_bytes: null },
        ],
      }),
    );
    expect(entry.storage_status).toBe("buffered");
  });

  it("collects every flagged version for the conflict inbox", () => {
    const entry = toCatalogEntry(
      file({
        versions: [
          { version_number: 1, shard_count: 1, version_hash: "a", conflict_status: "flagged", created_at: "x" },
          { version_number: 3, shard_count: 1, version_hash: "b", conflict_status: "flagged", created_at: "x" },
          { version_number: 2, shard_count: 1, version_hash: "c", conflict_status: "none", created_at: "x" },
        ],
      }),
    );
    expect(entry.conflicted_versions).toEqual([1, 3]);
  });

  it("returns null metadata for a file with no versions", () => {
    const entry = toCatalogEntry(file());
    expect(entry.latest_version_number).toBeNull();
    expect(entry.storage_status).toBeNull();
    expect(entry.conflicted_versions).toEqual([]);
  });

  it("treats the preferred version as current when one was recorded", () => {
    const entry = toCatalogEntry(
      file({
        preferred_version: 1,
        versions: [
          { version_number: 1, shard_count: 1, version_hash: "v1", conflict_status: "resolved", created_at: "x" },
          { version_number: 2, shard_count: 2, version_hash: "v2", conflict_status: "resolved", created_at: "x" },
        ],
        locations: [
          { version_number: 1, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: null, size_bytes: 10 },
          { version_number: 2, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: null, size_bytes: 20 },
          { version_number: 2, shard_index: 1, node_id: "n1", status: "NODE_STORED", hash: null, size_bytes: 20 },
        ],
      }),
    );

    expect(entry.preferred_version).toBe(1);
    expect(entry.latest_version_number).toBe(1);
    expect(entry.shard_count).toBe(1);
    expect(entry.version_hash).toBe("v1");
  });

  it("falls back to the newest version when preferred_version is unknown", () => {
    const entry = toCatalogEntry(
      file({
        preferred_version: 99,
        versions: [
          { version_number: 1, shard_count: 1, version_hash: "v1", conflict_status: "none", created_at: "x" },
          { version_number: 2, shard_count: 1, version_hash: "v2", conflict_status: "none", created_at: "x" },
        ],
      }),
    );
    expect(entry.latest_version_number).toBe(2);
  });
});
