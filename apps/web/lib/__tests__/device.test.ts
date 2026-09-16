import { describe, it, expect } from "vitest";
import { getOrCreateEncryptionIdentity, ENCRYPTION_IDENTITY_KEY } from "../device";

// The Ed25519 signing key is a non-extractable CryptoKey in IndexedDB (covered
// by the SDK's WebCrypto signer tests); these cover the browser-persisted
// X25519 encryption identity, which is the only key material in localStorage.

describe("getOrCreateEncryptionIdentity", () => {
  it("generates and persists an X25519 encryption identity", () => {
    const identity = getOrCreateEncryptionIdentity();

    expect(identity.public_key).toBeTruthy();
    expect(identity.private_key).toBeTruthy();

    const stored = JSON.parse(localStorage.getItem(ENCRYPTION_IDENTITY_KEY)!) as {
      public_key: string;
    };
    expect(stored.public_key).toBe(identity.public_key);
  });

  it("reuses the persisted identity on later calls", () => {
    const first = getOrCreateEncryptionIdentity();
    const second = getOrCreateEncryptionIdentity();

    expect(second.public_key).toBe(first.public_key);
    expect(second.private_key).toBe(first.private_key);
  });

  it("regenerates when the stored record is corrupt", () => {
    localStorage.setItem(ENCRYPTION_IDENTITY_KEY, "not-valid-json");

    const identity = getOrCreateEncryptionIdentity();

    expect(identity.public_key).toBeTruthy();
    const stored = JSON.parse(localStorage.getItem(ENCRYPTION_IDENTITY_KEY)!) as {
      public_key: string;
    };
    expect(stored.public_key).toBe(identity.public_key);
  });
});
