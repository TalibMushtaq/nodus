import { describe, expect, it } from "vitest";

import { serialize } from "../serialize";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("serialize", () => {
  it("runs same-key work one at a time, in order", async () => {
    const events: string[] = [];
    const work = (label: string) => async () => {
      events.push(`start:${label}`);
      await tick();
      events.push(`end:${label}`);
      return label;
    };

    const [a, b, c] = await Promise.all([
      serialize("k", work("a")),
      serialize("k", work("b")),
      serialize("k", work("c")),
    ]);

    expect([a, b, c]).toEqual(["a", "b", "c"]);
    // No interleaving: each end precedes the next start.
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("does not serialize across different keys", async () => {
    const events: string[] = [];
    const work = (label: string) => async () => {
      events.push(`start:${label}`);
      await tick();
      events.push(`end:${label}`);
    };

    await Promise.all([serialize("x", work("x")), serialize("y", work("y"))]);
    // Both start before either ends because they are independent chains.
    expect(events.slice(0, 2).sort()).toEqual(["start:x", "start:y"]);
  });

  it("keeps the chain alive after a rejection", async () => {
    const failing = serialize("k2", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(serialize("k2", async () => "ok")).resolves.toBe("ok");
  });
});
