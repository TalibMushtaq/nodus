import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptName, generateFileEncryptionKey } from "@repo/core";
import type { StoredDeviceIdentity } from "@repo/relay-client";

// The FEK lookup talks to SQLite/Relay; mock it so this test covers only the
// decrypt-and-tolerate-failure logic.
vi.mock("../keys", () => ({ fetchMobileFileKey: vi.fn() }));

import { fetchMobileFileKey } from "../keys";
import { decryptFileNames } from "../names";
import type { RelayFile } from "../../relay";

const device: StoredDeviceIdentity = {
  device_id: "dev-1",
  public_key: "cHVi",
  private_key: "cHJp",
};

const mockedKey = vi.mocked(fetchMobileFileKey);

function file(overrides: Partial<RelayFile> & { file_id: string }): RelayFile {
  return {
    parent_folder_id: null,
    encrypted_name: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    versions: [],
    locations: [],
    ...overrides,
  };
}

describe("decryptFileNames", () => {
  beforeEach(() => {
    mockedKey.mockReset();
  });

  it("decrypts names when the envelope opens and nulls the rest", async () => {
    const fek = generateFileEncryptionKey();
    const encrypted = encryptName("hello.txt", fek);
    mockedKey.mockImplementation(async (_device, fileId) => (fileId === "a" ? fek : null));

    const names = await decryptFileNames(device, [
      file({ file_id: "a", encrypted_name: encrypted }),
      file({ file_id: "b", encrypted_name: "unopenable" }),
      file({ file_id: "c", encrypted_name: null }),
    ]);

    expect(names.a).toBe("hello.txt");
    expect(names.b).toBeNull();
    expect(names.c).toBeNull();
  });

  it("tolerates a throwing key lookup without failing the listing", async () => {
    mockedKey.mockRejectedValue(new Error("relay down"));
    const names = await decryptFileNames(device, [
      file({ file_id: "a", encrypted_name: "whatever" }),
    ]);
    expect(names.a).toBeNull();
  });
});
