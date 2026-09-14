import { describe, expect, it } from "vitest";

import { formatBytes, formatCountdown, shortId } from "../format";

describe("formatCountdown", () => {
  it("renders MM:SS and clamps negatives to zero", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(5)).toBe("00:05");
    expect(formatCountdown(65)).toBe("01:05");
    expect(formatCountdown(600)).toBe("10:00");
    expect(formatCountdown(-3)).toBe("00:00");
    expect(formatCountdown(12.9)).toBe("00:12");
  });
});

describe("shortId", () => {
  it("truncates with an ellipsis only when longer than the limit", () => {
    expect(shortId("abcdefghij")).toBe("abcdefgh…");
    expect(shortId("abc")).toBe("abc");
  });
});

describe("formatBytes", () => {
  it("renders nullish and negative values as an em dash", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });

  it("scales through binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    // Sub-KB values (e.g. a decaying transfer rate) must not print fractions.
    expect(formatBytes(0.007043314722762237)).toBe("0 B");
    expect(formatBytes(42.6)).toBe("43 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});
