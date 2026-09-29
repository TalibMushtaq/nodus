import { describe, it, expect } from "vitest";

import { safeFileName } from "../filename";

describe("safeFileName", () => {
  it("keeps ordinary names", () => {
    expect(safeFileName("report.pdf")).toBe("report.pdf");
  });

  it("strips directory components and traversal", () => {
    expect(safeFileName("../../etc/passwd")).not.toContain("/");
    expect(safeFileName("../../etc/passwd")).not.toContain("..");
    expect(safeFileName("a/b/c.txt")).toBe("c.txt");
    expect(safeFileName("..\\..\\win.ini")).not.toContain("\\");
  });

  it("replaces reserved and control characters", () => {
    expect(safeFileName('a:b*c?"d.txt')).toBe("a_b_c__d.txt");
  });

  it("falls back to a fixed name when nothing usable remains", () => {
    // `..` is replaced non-overlapping, so `...` becomes `_.`.
    expect(safeFileName("...")).toBe("_.");
    expect(safeFileName("")).toBe("download.bin");
    expect(safeFileName("   ")).toBe("download.bin");
  });

  it("bounds the length to the filesystem limit", () => {
    expect(safeFileName("x".repeat(300)).length).toBe(255);
  });
});
