import { describe, expect, it } from "vitest";

import type { FileEntryView } from "../file-view";
import type { FolderView } from "../use-files";
import { MissingEnvelopeError, ShardUnavailableError, type DownloadDeps } from "../download";
import {
  buildFolderZip,
  classifySkip,
  collectFolderFiles,
  describeFolderSkips,
} from "../folder-download";
import type { RelayFileLocation } from "../catalog";

function makeFolder(folderId: string, name: string, parentFolderId: string | null): FolderView {
  return {
    folderId,
    parentFolderId,
    name,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makeFile(
  fileId: string,
  name: string,
  parentFolderId: string | null,
  overrides: Partial<FileEntryView> = {},
): FileEntryView {
  return {
    fileId,
    name,
    sizeBytes: 10,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    status: "synced",
    storageState: "node",
    parentFolderId,
    latestVersionNumber: 1,
    shardCount: 1,
    versionHash: "hash",
    encryptedName: "enc",
    locations: [],
    downloadable: true,
    ...overrides,
  };
}

describe("collectFolderFiles", () => {
  it("walks subfolders recursively and prefixes their names", () => {
    const folders = [
      makeFolder("a", "alpha", null),
      makeFolder("b", "beta", "a"),
    ];
    const files = [
      makeFile("f1", "root.txt", "a"),
      makeFile("f2", "nested.txt", "b"),
      makeFile("f3", "outside.txt", null),
    ];

    const collected = collectFolderFiles("a", folders, files);

    expect(collected.map((entry) => entry.path).sort()).toEqual(["beta/nested.txt", "root.txt"].sort());
  });

  it("sanitizes characters that are hostile to filesystems", () => {
    const folders = [makeFolder("a", "alpha", null), makeFolder("b", "a/b:c", "a")];
    const files = [makeFile("f1", "x*y?.txt", "a"), makeFile("f2", "z.txt", "b")];
    const collected = collectFolderFiles("a", folders, files);
    expect(collected.map((entry) => entry.path).sort()).toEqual(["a_b_c/z.txt", "x_y_.txt"].sort());
  });
});

describe("buildFolderZip", () => {
  it("skips files with no stored copy and still produces an archive", async () => {
    const folders = [makeFolder("a", "alpha", null)];
    const files = [
      makeFile("f1", "local-only.txt", "a", { downloadable: false }),
      makeFile("f2", "buffered.txt", "a", { downloadable: false }),
    ];
    // Deps must never be touched: neither file is downloadable.
    const deps: DownloadDeps = {
      fetchFileKey: async () => {
        throw new Error("should not fetch a key");
      },
      getShardLocations: async () => [],
      fetchShard: async () => {
        throw new Error("should not fetch a shard");
      },
    };

    const archive = await buildFolderZip({ folderName: "alpha", folderId: "a", folders, files, deps });

    expect(archive.fileCount).toBe(0);
    expect(archive.skipped.map((skip) => skip.name).sort()).toEqual(["buffered.txt", "local-only.txt"]);
    expect(archive.skipped.every((skip) => skip.kind === "not-stored")).toBe(true);
    expect(archive.fileName).toBe("alpha.zip");
    // End-of-central-directory signature confirms a structurally valid zip.
    expect(new DataView(archive.data.buffer, archive.data.byteOffset).getUint32(0, true)).toBe(0x06054b50);
  });

  it("classifies each download failure by cause instead of a blanket skip", async () => {
    const folders = [makeFolder("a", "alpha", null)];
    const storedLocation: RelayFileLocation = {
      version_number: 1,
      shard_index: 0,
      node_id: "n1",
      status: "NODE_STORED",
      hash: null,
      size_bytes: 8,
    };
    const files = [
      makeFile("f1", "no-key.txt", "a"),
      makeFile("f2", "not-paired.txt", "a"),
      makeFile("f3", "corrupt.txt", "a"),
    ];
    const deps: DownloadDeps = {
      fetchFileKey: async (fileId) => (fileId === "f1" ? null : new Uint8Array(1)),
      getShardLocations: async () => [storedLocation],
      fetchShard: async (fileId) => {
        if (fileId === "f2") throw new ShardUnavailableError(0, "no_trusted_host");
        throw new ShardUnavailableError(0, "integrity mismatch");
      },
    };

    const archive = await buildFolderZip({ folderName: "alpha", folderId: "a", folders, files, deps });

    expect(archive.fileCount).toBe(0);
    expect(archive.skipped).toEqual([
      { name: "no-key.txt", kind: "missing-key", detail: expect.stringContaining("no key envelope") },
      { name: "not-paired.txt", kind: "not-paired", detail: "shard 0 is not downloadable (status: no_trusted_host)" },
      { name: "corrupt.txt", kind: "failed", detail: "shard 0 is not downloadable (status: integrity mismatch)" },
    ]);
  });
});

describe("classifySkip", () => {
  it("maps envelope, pairing, and generic failures to distinct kinds", () => {
    expect(classifySkip(new MissingEnvelopeError("f1"))).toBe("missing-key");
    expect(classifySkip(new ShardUnavailableError(0, "no_trusted_host"))).toBe("not-paired");
    // A shard genuinely not committed on a node is a storage gap, not a pairing one.
    expect(classifySkip(new ShardUnavailableError(0, "RELAY_BUFFERED"))).toBe("failed");
    expect(classifySkip(new Error("network down"))).toBe("failed");
    expect(classifySkip("raw string")).toBe("failed");
  });
});

describe("describeFolderSkips", () => {
  it("groups skipped files by cause with a pairing flag", () => {
    const summary = describeFolderSkips([
      { name: "a.txt", kind: "not-stored" },
      { name: "b.txt", kind: "not-stored" },
      { name: "c.txt", kind: "not-paired" },
      { name: "d.txt", kind: "missing-key" },
      { name: "e.txt", kind: "failed" },
    ]);
    expect(summary.pairingNeeded).toBe(true);
    expect(summary.message).toEqual(
      "2 file(s) still buffered — not stored on a node yet; 1 file(s) stored on a node this browser isn't paired with; 1 file(s) can't be decrypted on this device (no key); 1 file(s) failed for another reason.",
    );
  });

  it("does not flag pairing when no node-stored shard was skipped", () => {
    const summary = describeFolderSkips([{ name: "a.txt", kind: "not-stored" }]);
    expect(summary.pairingNeeded).toBe(false);
    expect(summary.message).toBe("1 file(s) still buffered — not stored on a node yet.");
  });
});
