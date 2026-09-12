import { describe, expect, it } from "vitest";

import { tombstoneStatus, type TombstoneItem } from "../tombstones";

function item(partial: Partial<TombstoneItem> = {}): TombstoneItem {
  return {
    entity_type: "file",
    entity_id: "f1",
    encrypted_name: null,
    deleted_at: "2026-09-12T00:00:00Z",
    purge_after: "2026-12-11T00:00:00Z",
    purge_requested_at: null,
    nodes: [{ node_id: "n1", deleted_at: "2026-09-12T00:00:00Z", purged_at: null }],
    ...partial,
  };
}

describe("tombstoneStatus", () => {
  it("reports deleted from relay and node once nodes ack the tombstone", () => {
    expect(tombstoneStatus(item()).label).toBe("Deleted from Relay and node");
  });

  it("reports waiting for a node that has not acked", () => {
    const status = tombstoneStatus(item({ nodes: [{ node_id: "n1", deleted_at: null, purged_at: null }] }));
    expect(status.tone).toBe("pending");
    expect(status.label).toMatch(/waiting for 1 node/);
  });

  it("reports purging while a node is outstanding", () => {
    const status = tombstoneStatus(
      item({
        purge_requested_at: "2026-09-13T00:00:00Z",
        nodes: [{ node_id: "n1", deleted_at: "2026-09-12T00:00:00Z", purged_at: null }],
      }),
    );
    expect(status.label).toMatch(/Purging/);
  });

  it("reports permanently deleted once every node has purged", () => {
    const status = tombstoneStatus(
      item({
        purge_requested_at: "2026-09-13T00:00:00Z",
        nodes: [{ node_id: "n1", deleted_at: "2026-09-12T00:00:00Z", purged_at: "2026-09-14T00:00:00Z" }],
      }),
    );
    expect(status.label).toBe("Permanently deleted");
  });

  it("treats no owning nodes (local-only file or folder) as complete", () => {
    expect(tombstoneStatus(item({ nodes: [] })).label).toBe("Deleted (Relay)");
  });
});
