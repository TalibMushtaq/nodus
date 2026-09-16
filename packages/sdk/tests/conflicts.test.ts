import { describe, expect, it } from "vitest";
import { encryptName, generateFileEncryptionKey } from "@repo/core";

import { listConflicts } from "../src/conflicts/conflicts.js";
import type { CatalogEntry } from "../src/catalog/catalog.js";

function entry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    file_id: "file-1",
    parent_folder_id: null,
    encrypted_name: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    latest_version_number: 1,
    shard_count: 1,
    version_hash: "h",
    conflict_status: "flagged",
    conflicted_versions: [1],
    conflicted_name: null,
    storage_status: "stored",
    locations: [],
    cached_at: "x",
    ...overrides,
  };
}

describe("listConflicts", () => {
  it("keeps only conflicted files and decrypts names when the key resolves", async () => {
    const fek = generateFileEncryptionKey();
    const rows = await listConflicts({
      listCatalog: async () => [
        entry({ file_id: "a", encrypted_name: encryptName("report.txt", fek), updated_at: "2026-02-01T00:00:00Z" }),
        entry({ file_id: "b", conflicted_versions: [] }),
      ],
      resolveFileKey: async (fileId) => (fileId === "a" ? fek : null),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileId).toBe("a");
    expect(rows[0]!.name).toBe("report.txt");
  });

  it("falls back to a labelled short id when no key is available", async () => {
    const rows = await listConflicts({
      listCatalog: async () => [entry({ file_id: "abcdefghij", encrypted_name: "opaque" })],
      resolveFileKey: async () => null,
    });
    expect(rows[0]!.name).toBe("Encrypted · abcdefgh…");
  });

  it("uses a plain short id when the file has no encrypted name", async () => {
    const rows = await listConflicts({
      listCatalog: async () => [entry({ file_id: "abcdefghij", encrypted_name: null })],
      resolveFileKey: async () => null,
    });
    expect(rows[0]!.name).toBe("abcdefgh…");
  });

  it("surfaces the node-computed sibling name for a flagged copy", async () => {
    const rows = await listConflicts({
      listCatalog: async () => [
        entry({ file_id: "a", conflicted_name: "report (conflicted copy 3f9a 2026-08-31).txt" }),
      ],
      resolveFileKey: async () => null,
    });
    expect(rows[0]!.siblingName).toBe("report (conflicted copy 3f9a 2026-08-31).txt");
  });

  it("reports a null sibling name when the Relay has none", async () => {
    const rows = await listConflicts({
      listCatalog: async () => [entry({ file_id: "a", conflicted_name: null })],
      resolveFileKey: async () => null,
    });
    expect(rows[0]!.siblingName).toBeNull();
  });
});
