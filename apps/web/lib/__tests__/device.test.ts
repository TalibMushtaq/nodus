import { describe, it, expect, beforeEach } from "vitest";
import {
  clearEncryptionIdentity,
  clearEncryptionMemory,
  getEncryptionPublicKey,
  getOrCreateEncryptionIdentity,
  ENCRYPTION_IDENTITY_KEY,
} from "../device";

// The Ed25519 signing key is a non-extractable CryptoKey in IndexedDB (covered
// by the SDK's WebCrypto signer tests); these cover the browser-persisted
// X25519 encryption identity, whose private half lives in IndexedDB with only
// the public half cached in localStorage.

beforeEach(async () => {
  await clearEncryptionIdentity();
});

describe("getOrCreateEncryptionIdentity", () => {
  it("generates and persists an X25519 encryption identity", async () => {
    const identity = await getOrCreateEncryptionIdentity();

    expect(identity.public_key).toBeTruthy();
    expect(identity.private_key).toBeTruthy();

    // Only the publishable public half stays synchronously readable; the
    // private bytes must never touch localStorage.
    const stored = JSON.parse(localStorage.getItem(ENCRYPTION_IDENTITY_KEY)!) as {
      public_key?: string;
      private_key?: string;
    };
    expect(stored.public_key).toBe(identity.public_key);
    expect(stored.private_key).toBeUndefined();
    expect(getEncryptionPublicKey()).toBe(identity.public_key);
  });

  it("reuses the persisted identity on later calls", async () => {
    const first = await getOrCreateEncryptionIdentity();
    const second = await getOrCreateEncryptionIdentity();

    expect(second.public_key).toBe(first.public_key);
    expect(second.private_key).toBe(first.private_key);
  });

  it("migrates a legacy localStorage identity and drops its private bytes", async () => {
    const legacy = JSON.stringify({ public_key: "legacy-pub", private_key: "legacy-priv" });
    localStorage.setItem(ENCRYPTION_IDENTITY_KEY, legacy);

    const identity = await getOrCreateEncryptionIdentity();

    expect(identity.public_key).toBe("legacy-pub");
    expect(identity.private_key).toBe("legacy-priv");
    const stored = JSON.parse(localStorage.getItem(ENCRYPTION_IDENTITY_KEY)!) as {
      private_key?: string;
    };
    expect(stored.private_key).toBeUndefined();
  });

  it("regenerates when the stored record is corrupt", async () => {
    localStorage.setItem(ENCRYPTION_IDENTITY_KEY, "not-valid-json");

    const identity = await getOrCreateEncryptionIdentity();

    expect(identity.public_key).toBeTruthy();
  });

  it("forgets the identity on clear", async () => {
    await getOrCreateEncryptionIdentity();
    await clearEncryptionIdentity();

    expect(localStorage.getItem(ENCRYPTION_IDENTITY_KEY)).toBeNull();
    expect(getEncryptionPublicKey()).toBeNull();
  });

  it("keeps the persisted identity across a memory-only clear (logout)", async () => {
    const first = await getOrCreateEncryptionIdentity();

    clearEncryptionMemory();

    // The public half is still synchronously readable and a reload picks up the
    // same keypair, so envelopes sealed to the old public key still open.
    expect(getEncryptionPublicKey()).toBe(first.public_key);
    const second = await getOrCreateEncryptionIdentity();
    expect(second.public_key).toBe(first.public_key);
    expect(second.private_key).toBe(first.private_key);
  });
});
