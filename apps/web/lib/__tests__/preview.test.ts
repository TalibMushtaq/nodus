import { describe, expect, it, vi } from "vitest";

// Keep the test to preview.ts's pure surface: stub the download stack and the
// auth hook so importing the module does not pull in the whole app graph.
vi.mock("../download", () => ({ browserDownloadDeps: vi.fn(), downloadFile: vi.fn() }));
vi.mock("../../providers/auth-provider", () => ({ useAuth: vi.fn() }));

import { isImageFileName, loadImagePreview, revokeAllPreviews } from "../preview";
import { downloadFile } from "../download";
import type { FileEntryView } from "../file-view";

const mockDownload = vi.mocked(downloadFile);

describe("preview eligibility", () => {
  it("accepts raster images", () => {
    expect(isImageFileName("photo.PNG")).toBe(true);
    expect(isImageFileName("a.jpeg")).toBe(true);
    expect(isImageFileName("logo.webp")).toBe(true);
  });

  it("rejects SVG, which can carry scripts and must not be previewed inline", () => {
    expect(isImageFileName("logo.svg")).toBe(false);
    expect(isImageFileName("anim.SVG")).toBe(false);
  });

  it("rejects non-images", () => {
    expect(isImageFileName("notes.txt")).toBe(false);
    expect(isImageFileName("no-extension")).toBe(false);
  });
});

describe("revokeAllPreviews", () => {
  it("is safe to call with an empty cache", () => {
    expect(() => revokeAllPreviews()).not.toThrow();
  });
});

describe("loadImagePreview", () => {
  const file: FileEntryView = {
    fileId: "f1",
    name: "photo.png",
    sizeBytes: 10,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    status: "synced",
    storageState: "node",
    parentFolderId: null,
    latestVersionNumber: 1,
    shardCount: 1,
    versionHash: "hash",
    encryptedName: "enc",
    locations: [],
    downloadable: true,
  };

  it("refuses to cache a preview that resolves after revokeAllPreviews", async () => {
    let resolveDownload!: (value: { data: Uint8Array }) => void;
    mockDownload.mockImplementation(
      () => new Promise((resolve) => { resolveDownload = resolve; }) as never,
    );

    const pending = loadImagePreview(file, {} as never, {} as never);
    // Let the concurrency gate open so downloadFile is actually invoked.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A logout/revocation lands while the download is in flight.
    revokeAllPreviews();
    resolveDownload({ data: new Uint8Array([1, 2, 3]) });

    await expect(pending).resolves.toBeNull();
  });
});
