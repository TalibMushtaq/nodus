import { describe, it, expect } from "vitest";
import { generateFileEncryptionKey } from "@repo/core";

import { clearFileKeys, deleteFileKey, getFileKey, putFileKey } from "../keys";

// The local FEK cache is the fast path for decrypting own uploads after a
// reload; Relay envelopes are the source of truth. These cover the logout
// wipe that keeps a shared browser from retaining decryption material.
describe("clearFileKeys", () => {
  it("stores and retrieves a file key, then wipes it", async () => {
    const fek = generateFileEncryptionKey();
    await putFileKey("file-1", fek);
    expect(await getFileKey("file-1")).toBeDefined();

    await clearFileKeys();

    expect(await getFileKey("file-1")).toBeUndefined();
  });

  it("deletes a single key without touching others", async () => {
    await putFileKey("file-a", generateFileEncryptionKey());
    await putFileKey("file-b", generateFileEncryptionKey());
    await deleteFileKey("file-a");

    expect(await getFileKey("file-a")).toBeUndefined();
    expect(await getFileKey("file-b")).toBeDefined();

    await clearFileKeys();
  });
});
