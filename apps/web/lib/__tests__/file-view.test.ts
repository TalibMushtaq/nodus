import { describe, expect, it } from "vitest";

import { isDownloadable, latestSize, toSyncStatus } from "../file-view";
import type { CatalogEntry } from "../catalog";

function entry(partial: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    file_id: "f1",
    parent_folder_id: null,
    encrypted_name: "enc",
    created_at: "2026-09-12T00:00:00Z",
    updated_at: "2026-09-12T00:00:00Z",
    latest_version_number: 1,
    shard_count: 2,
    version_hash: "vh",
    conflict_status: "none",
    storage_status: "stored",
    locations: [
      { version_number: 1, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: "h0", size_bytes: 10 },
      { version_number: 1, shard_index: 1, node_id: "n1", status: "NODE_STORED", hash: "h1", size_bytes: 20 },
    ],
    cached_at: "2026-09-12T00:00:00Z",
    ...partial,
  };
}

describe("toSyncStatus", () => {
  it("maps storage rollups to the app status vocabulary", () => {
    expect(toSyncStatus(entry({ storage_status: "stored" }))).toBe("synced");
    expect(toSyncStatus(entry({ storage_status: "buffered" }))).toBe("pending");
    expect(toSyncStatus(entry({ storage_status: "transferring" }))).toBe("pending");
    expect(toSyncStatus(entry({ storage_status: "unknown" }))).toBe("local-only");
    expect(toSyncStatus(entry({ storage_status: null, latest_version_number: null }))).toBe("local-only");
  });

  it("reports conflicts regardless of storage status", () => {
    expect(toSyncStatus(entry({ conflict_status: "CONFLICT", storage_status: "stored" }))).toBe("conflict");
  });
});

describe("latestSize", () => {
  it("sums the latest version's known shard sizes", () => {
    expect(latestSize(entry())).toBe(30);
  });

  it("ignores other versions and null sizes, and reports null when nothing is known", () => {
    expect(
      latestSize(
        entry({
          locations: [
            { version_number: 1, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: "h0", size_bytes: 10 },
            { version_number: 2, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: "h2", size_bytes: 999 },
          ],
        }),
      ),
    ).toBe(10);
    expect(latestSize(entry({ locations: [] }))).toBeNull();
    expect(latestSize(entry({ latest_version_number: null }))).toBeNull();
  });
});

describe("isDownloadable", () => {
  it("is true only when every latest-version shard is NODE_STORED", () => {
    expect(isDownloadable(entry())).toBe(true);
    expect(
      isDownloadable(
        entry({
          locations: [
            { version_number: 1, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: "h0", size_bytes: 10 },
            { version_number: 1, shard_index: 1, node_id: "n1", status: "RELAY_BUFFERED", hash: "h1", size_bytes: 20 },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is false when there is no version or shard count", () => {
    expect(isDownloadable(entry({ latest_version_number: null }))).toBe(false);
    expect(isDownloadable(entry({ shard_count: null }))).toBe(false);
  });
});
