// Unit tests for the Activity-tab projections.

import { describe, expect, it } from "vitest";

import { filterActivity, isTransferPath, matchesFilter } from "../view";
import type { TransferLogEntry } from "../../store/transfer-log";

function entry(partial: Partial<TransferLogEntry> = {}): TransferLogEntry {
  return {
    id: "1",
    kind: "upload",
    fileId: "f1",
    fileName: "a.txt",
    detail: null,
    path: null,
    outcome: "complete",
    createdAt: "2026-09-17T00:00:00Z",
    ...partial,
  };
}

describe("matchesFilter", () => {
  it("filters by kind and by failure", () => {
    expect(matchesFilter(entry({ kind: "upload" }), "Uploads")).toBe(true);
    expect(matchesFilter(entry({ kind: "download" }), "Uploads")).toBe(false);
    expect(matchesFilter(entry({ kind: "conflict" }), "Conflicts")).toBe(true);
    expect(matchesFilter(entry({ outcome: "failed" }), "Errors")).toBe(true);
    expect(matchesFilter(entry({ outcome: "complete" }), "Errors")).toBe(false);
    expect(matchesFilter(entry(), "All")).toBe(true);
  });
});

describe("filterActivity", () => {
  it("keeps only the matching entries, preserving order", () => {
    const entries = [
      entry({ id: "a", kind: "upload" }),
      entry({ id: "b", kind: "download" }),
      entry({ id: "c", kind: "upload", outcome: "failed" }),
    ];
    expect(filterActivity(entries, "All").map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(filterActivity(entries, "Uploads").map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterActivity(entries, "Errors").map((e) => e.id)).toEqual(["c"]);
  });
});

describe("isTransferPath", () => {
  it("accepts the four manager paths and rejects anything else", () => {
    expect(isTransferPath("local_signaling")).toBe(true);
    expect(isTransferPath("relay_signaling")).toBe(true);
    expect(isTransferPath("buffer_relay")).toBe(true);
    expect(isTransferPath("local_queue")).toBe(true);
    expect(isTransferPath(null)).toBe(false);
    expect(isTransferPath("something_else")).toBe(false);
  });
});
