import { describe, it, expect, vi } from "vitest";

import { openAtRest, openStringAtRest, sealAtRest, sealStringAtRest, isSealed } from "./at-rest";

const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    store.set(k, v);
  },
}));
vi.mock("expo-crypto", () => ({
  getRandomBytes: (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
}));

describe("at-rest encryption", () => {
  it("round-trips strings without leaving plaintext", async () => {
    const sealed = await sealStringAtRest("word1 word2 secret");
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain("secret");
    expect(await openStringAtRest(sealed)).toBe("word1 word2 secret");
  });

  it("round-trips arbitrary key bytes", async () => {
    const fek = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
    const sealed = await sealAtRest(fek);
    expect(Array.from((await openAtRest(sealed))!)).toEqual(Array.from(fek));
  });

  it("returns null for corrupt or unsealed values instead of throwing", async () => {
    expect(await openAtRest("v1:deadbeef")).toBeNull();
    expect(await openStringAtRest("plaintext")).toBeNull();
  });
});
