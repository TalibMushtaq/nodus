import { describe, expect, it } from "vitest";

import type { FileEntryView } from "../file-view";
import type { FolderView } from "../use-files";
import type { DownloadDeps } from "../download";
import { buildFolderZip, collectFolderFiles } from "../folder-download";

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
    expect(archive.skipped.sort()).toEqual(["buffered.txt", "local-only.txt"]);
    expect(archive.fileName).toBe("alpha.zip");
    // End-of-central-directory signature confirms a structurally valid zip.
    expect(new DataView(archive.data.buffer, archive.data.byteOffset).getUint32(0, true)).toBe(0x06054b50);
  });
});
