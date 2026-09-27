import { describe, expect, it, vi } from "vitest";

// Keep the test to preview.ts's pure surface: stub the download stack and the
// auth hook so importing the module does not pull in the whole app graph.
vi.mock("../download", () => ({ browserDownloadDeps: vi.fn(), downloadFile: vi.fn() }));
vi.mock("../../providers/auth-provider", () => ({ useAuth: vi.fn() }));

import { isImageFileName, revokeAllPreviews } from "../preview";

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
