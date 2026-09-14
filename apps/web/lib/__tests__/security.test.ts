import { describe, expect, it } from "vitest";

import type { EnvelopeSummary } from "../envelopes";
import type { RelayDevice, RelayNode } from "../pairing";
import { envelopeRows } from "../security";

function device(partial: Partial<RelayDevice> = {}): RelayDevice {
  return {
    device_id: "dev-abcdef123456",
    account_id: "a1",
    public_key: "pk",
    status: "ACTIVE",
    created_at: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

function node(partial: Partial<RelayNode> = {}): RelayNode {
  return {
    node_id: "node-abcdef123456",
    account_id: "a1",
    public_key: "pk",
    capabilities: ["storage"],
    status: "ACTIVE",
    is_primary: true,
    created_at: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

describe("envelopeRows", () => {
  it("resolves device/node display names and keeps counts", () => {
    const summaries: EnvelopeSummary[] = [
      { recipient_id: "dev-abcdef123456", recipient_kind: "device", file_count: 12, folder_count: 3, last_updated: "2026-09-10T00:00:00Z" },
      { recipient_id: "node-abcdef123456", recipient_kind: "node", file_count: 12, folder_count: 3, last_updated: "2026-09-09T00:00:00Z" },
    ];
    const rows = envelopeRows(
      summaries,
      [device({ display_name: "MacBook Pro" })],
      [node({ display_name: "Home NAS" })],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "MacBook Pro", fileCount: 12, folderCount: 3 });
    expect(rows[1]).toMatchObject({ name: "Home NAS", fileCount: 12 });
  });

  it("falls back to the short id for an unknown or unnamed recipient", () => {
    const rows = envelopeRows(
      [{ recipient_id: "dev-abcdef123456", recipient_kind: "device", file_count: 1, folder_count: 0, last_updated: null }],
      [],
      [],
    );
    expect(rows[0]?.name).not.toBe("dev-abcdef123456");
    expect(rows[0]?.name.startsWith("dev-abcd")).toBe(true);
  });

  it("labels a recovery recipient explicitly", () => {
    const rows = envelopeRows(
      [{ recipient_id: "recoverypubkey", recipient_kind: "recovery", file_count: 4, folder_count: 1, last_updated: null }],
      [],
      [],
    );
    expect(rows[0]).toMatchObject({ name: "Recovery key", fileCount: 4, folderCount: 1 });
  });
});
