// Unit tests for the file-row projections used by the Files UI.

import { describe, expect, it } from "vitest";

import { toFileRow, type FileRow } from "../view";
import type { RelayFile } from "../../relay";

/** Build a relay file with sensible defaults so each test states only its delta. */
function makeFile(overrides: Partial<RelayFile> = {}): RelayFile {
  return {
    file_id: "file-1",
    parent_folder_id: null,
    encrypted_name: "encrypted",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    versions: [
      {
        version_number: 1,
        shard_count: 2,
        version_hash: "hash",
        conflict_status: "ok",
        conflicted_name: null,
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
    locations: [
      {
        version_number: 1,
        shard_index: 0,
        node_id: "node-1",
        status: "NODE_STORED",
        hash: "a",
        size_bytes: 100,
      },
      {
        version_number: 1,
        shard_index: 1,
        node_id: "node-1",
        status: "NODE_STORED",
        hash: "b",
        size_bytes: 200,
      },
    ],
    ...overrides,
  };
}

function row(overrides: Partial<RelayFile> = {}, name: string | null = "notes.md"): FileRow {
  return toFileRow(makeFile(overrides), name);
}

const CONFLICTED_VERSION = {
  version_number: 1,
  shard_count: 2,
  version_hash: "hash",
  conflict_status: "flagged",
  conflicted_name: "notes (conflicted copy).md",
  created_at: "2026-09-01T00:00:00Z",
};

describe("toFileRow status", () => {
  it("marks fully stored files as synced", () => {
    expect(row().status).toBe("synced");
  });

  it("marks buffered files as pending", () => {
    const locations = [
      {
        version_number: 1,
        shard_index: 0,
        node_id: "node-1",
        status: "UPLOADING",
        hash: null,
        size_bytes: 100,
      },
    ];
    expect(row({ locations }).status).toBe("pending");
  });

  it("flags a file with any conflicted version", () => {
    expect(row({ versions: [CONFLICTED_VERSION] }).status).toBe("conflict");
  });
});

describe("toFileRow metadata", () => {
  it("sums the latest version's shard sizes", () => {
    expect(row().sizeBytes).toBe(300);
  });

  it("is null when the latest version has no sized locations", () => {
    expect(row({ locations: [] }).sizeBytes).toBeNull();
  });

  it("falls back to a short id when the name cannot be decrypted", () => {
    const result = row({}, null);
    expect(result.name).not.toBe("notes.md");
    expect(result.name.length).toBeGreaterThan(0);
  });

  it("reports downloadable only when every shard is stored", () => {
    expect(row().downloadable).toBe(true);
    const oneShard = makeFile().locations.slice(0, 1);
    expect(row({ locations: oneShard }).downloadable).toBe(false);
  });

  it("exposes the conflicted sibling name", () => {
    expect(row({ versions: [CONFLICTED_VERSION] }).conflictedName).toBe(
      "notes (conflicted copy).md",
    );
  });
});
