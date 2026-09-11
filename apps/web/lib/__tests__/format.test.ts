import { describe, expect, it } from "vitest";

import { formatCountdown, shortId } from "../format";

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
