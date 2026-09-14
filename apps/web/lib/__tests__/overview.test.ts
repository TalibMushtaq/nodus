import { describe, expect, it } from "vitest";

import type { RelayNode, RelayDevice } from "../pairing";
import type { FileEntryView } from "../file-view";
import type { TombstoneItem } from "../tombstones";
import type { TransferLogEntry } from "../transfer-log";
import {
  activityLabel,
  activityPathFromTransfer,
  isDeviceOnline,
  onlineCounts,
  pendingShardCount,
  recentActivity,
  recentFiles,
  storageUsage,
  tombstoneWindow,
  DEVICE_ONLINE_WINDOW_MS,
} from "../overview";

const NOW = Date.parse("2026-09-14T12:00:00Z");

function node(partial: Partial<RelayNode> = {}): RelayNode {
  return {
    node_id: "n1",
    account_id: "a1",
    public_key: "pk",
    capabilities: ["storage"],
    status: "ACTIVE",
    is_primary: true,
    created_at: "2026-09-01T00:00:00Z",
    last_seen_at: new Date(NOW - 1000).toISOString(),
    used_bytes: 100,
    total_bytes: 1000,
    ...partial,
  };
}

function device(partial: Partial<RelayDevice> = {}): RelayDevice {
  return {
    device_id: "d1",
    account_id: "a1",
    public_key: "pk",
    status: "ACTIVE",
    created_at: "2026-09-01T00:00:00Z",
    last_seen_at: new Date(NOW - 1000).toISOString(),
    ...partial,
  };
}

function file(partial: Partial<FileEntryView> = {}): FileEntryView {
  return {
    fileId: "f1",
    name: "a.txt",
    sizeBytes: 10,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
    status: "synced",
    storageState: "node",
    parentFolderId: null,
    latestVersionNumber: 1,
    shardCount: 2,
    versionHash: "vh",
    encryptedName: "enc",
    locations: [
      { version_number: 1, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: "h0", size_bytes: 5 },
      { version_number: 1, shard_index: 1, node_id: "n1", status: "NODE_STORED", hash: "h1", size_bytes: 5 },
    ],
    downloadable: true,
    ...partial,
  };
}

function tombstone(partial: Partial<TombstoneItem> = {}): TombstoneItem {
  return {
    entity_type: "file",
    entity_id: "f1",
    encrypted_name: "enc",
    deleted_at: "2026-09-01T00:00:00Z",
    purge_after: "2026-11-30T00:00:00Z",
    purge_requested_at: null,
    nodes: [],
    ...partial,
  };
}

describe("storageUsage", () => {
  it("sums the capacity nodes reported", () => {
    const usage = storageUsage([
      node({ used_bytes: 100, total_bytes: 1000 }),
      node({ node_id: "n2", used_bytes: 50, total_bytes: 500 }),
    ]);
    expect(usage).toEqual({ usedBytes: 150, totalBytes: 1500, capacityKnown: true });
  });

  it("excludes nodes that have not reported capacity from the denominator", () => {
    const usage = storageUsage([node({ total_bytes: 0 }), node({ node_id: "n2", total_bytes: 500 })]);
    expect(usage.totalBytes).toBe(500);
    expect(usage.capacityKnown).toBe(true);
  });

  it("reports unknown capacity when no node has reported a total", () => {
    const usage = storageUsage([node({ total_bytes: 0 }), node({ node_id: "n2", total_bytes: 0 })]);
    expect(usage).toEqual({ usedBytes: 200, totalBytes: 0, capacityKnown: false });
  });
});

describe("isDeviceOnline / onlineCounts", () => {
  it("treats a device inside the heartbeat window as online", () => {
    expect(isDeviceOnline(device({ last_seen_at: new Date(NOW - 1000).toISOString() }), NOW)).toBe(true);
  });

  it("treats a stale, unseen, or revoked device as offline", () => {
    expect(isDeviceOnline(device({ last_seen_at: new Date(NOW - DEVICE_ONLINE_WINDOW_MS - 1).toISOString() }), NOW)).toBe(false);
    expect(isDeviceOnline(device({ last_seen_at: null }), NOW)).toBe(false);
    expect(isDeviceOnline(device({ status: "REVOKED" }), NOW)).toBe(false);
  });

  it("rolls nodes and devices into online counts", () => {
    const counts = onlineCounts(
      [node(), node({ node_id: "n2", last_seen_at: new Date(NOW - 10 * 60 * 1000).toISOString() })],
      [device(), device({ device_id: "d2", last_seen_at: null })],
      NOW,
    );
    expect(counts).toEqual({ nodesOnline: 1, nodesTotal: 2, devicesOnline: 1, devicesTotal: 2 });
  });
});

describe("pendingShardCount", () => {
  it("counts latest-version shards that are not node-stored plus the local queue", () => {
    const files = [
      file({
        locations: [
          { version_number: 1, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: "h0", size_bytes: 5 },
          { version_number: 1, shard_index: 1, node_id: "n1", status: "RELAY_BUFFERED", hash: null, size_bytes: 5 },
        ],
      }),
    ];
    expect(pendingShardCount(files, 3)).toBe(4);
  });

  it("ignores older versions and files with no version", () => {
    const files = [
      file({
        latestVersionNumber: 2,
        locations: [
          { version_number: 1, shard_index: 0, node_id: "n1", status: "RELAY_BUFFERED", hash: null, size_bytes: 5 },
          { version_number: 2, shard_index: 0, node_id: "n1", status: "NODE_STORED", hash: "h0", size_bytes: 5 },
        ],
      }),
      file({ fileId: "f2", latestVersionNumber: null, locations: [] }),
    ];
    expect(pendingShardCount(files, 0)).toBe(0);
  });
});

describe("tombstoneWindow", () => {
  it("returns the soonest purge remaining", () => {
    const result = tombstoneWindow(
      [tombstone({ purge_after: "2026-11-30T00:00:00Z" }), tombstone({ entity_id: "f2", purge_after: "2026-10-01T00:00:00Z" })],
      NOW,
    );
    expect(result.windowDays).toBe(90);
    expect(result.daysRemaining).toBe(17);
  });

  it("returns a null countdown when the trash is empty", () => {
    expect(tombstoneWindow([], NOW)).toEqual({ daysRemaining: null, windowDays: 90 });
  });
});

describe("recentFiles / recentActivity", () => {
  it("sorts files newest-updated first and trims", () => {
    const files = [
      file({ fileId: "old", updatedAt: "2026-01-01T00:00:00Z" }),
      file({ fileId: "new", updatedAt: "2026-09-01T00:00:00Z" }),
    ];
    expect(recentFiles(files, 1).map((f) => f.fileId)).toEqual(["new"]);
  });

  it("trims the already-newest-first activity log", () => {
    const entries = ["a", "b", "c"].map(
      (id): TransferLogEntry => ({
        id,
        kind: "upload",
        fileId: "f",
        fileName: id,
        outcome: "complete",
        at: "2026-09-01T00:00:00Z",
      }),
    );
    expect(recentActivity(entries, 2).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("activityPathFromTransfer", () => {
  it("maps the transfer-manager paths to the UI vocabulary", () => {
    expect(activityPathFromTransfer("local_signaling")).toBe("local");
    expect(activityPathFromTransfer("relay_signaling")).toBe("relay");
    expect(activityPathFromTransfer("buffer_relay")).toBe("buffered");
    expect(activityPathFromTransfer("local_queue")).toBe("buffered");
    expect(activityPathFromTransfer(undefined)).toBeUndefined();
  });
});

describe("activityLabel", () => {
  it("labels outcomes per kind", () => {
    const base: TransferLogEntry = {
      id: "1",
      kind: "upload",
      fileId: "f",
      fileName: "a",
      outcome: "complete",
      at: "2026-09-01T00:00:00Z",
    };
    expect(activityLabel(base)).toBe("Uploaded");
    expect(activityLabel({ ...base, outcome: "failed" })).toBe("Upload failed");
    expect(activityLabel({ ...base, outcome: "in-progress", kind: "download" })).toBe("Downloading");
  });
});
