import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import {
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  normalizeRecoveryPhrase,
  recoveryIdentityFromPhrase,
  signRecoveryChallenge,
} from "../src/recovery.js";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A standard BIP39 test vector, so the derivation is pinned against a fixed
// input/output rather than only re-deriving itself in the test.
const VECTOR_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_PUBLIC_KEY = "186317a37ded5c9e6e3a25294b1a53eb3e0b488c6bff75e1bb993f1deb7a2714";

describe("recovery phrase", () => {
  it("generates a valid 24-word English mnemonic", () => {
    const phrase = generateRecoveryPhrase();
    expect(phrase.split(" ")).toHaveLength(24);
    expect(isValidRecoveryPhrase(phrase)).toBe(true);
  });

  it("validates known-good and rejects malformed phrases", () => {
    expect(isValidRecoveryPhrase(VECTOR_PHRASE)).toBe(true);
    expect(isValidRecoveryPhrase("not a real phrase")).toBe(false);
    expect(isValidRecoveryPhrase("")).toBe(false);
  });

  it("normalizes case and whitespace before validation", () => {
    expect(normalizeRecoveryPhrase("  Abandon\nABANDON   about  ")).toBe("abandon abandon about");
  });

  it("derives the pinned public key deterministically", () => {
    const identity = recoveryIdentityFromPhrase(VECTOR_PHRASE);
    expect(hex(identity.publicKey)).toBe(VECTOR_PUBLIC_KEY);
    expect(hex(recoveryIdentityFromPhrase(VECTOR_PHRASE).publicKey)).toBe(VECTOR_PUBLIC_KEY);
  });

  it("derives different identities for different phrases", () => {
    const other = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    expect(hex(recoveryIdentityFromPhrase(other).publicKey)).not.toBe(VECTOR_PUBLIC_KEY);
  });

  it("throws on an invalid phrase rather than deriving a wrong key", () => {
    expect(() => recoveryIdentityFromPhrase("definitely not a mnemonic")).toThrow();
  });

  it("signs a challenge that verifies against the derived public key", () => {
    const nonce = "aabbccdd";
    const signature = signRecoveryChallenge(VECTOR_PHRASE, new TextEncoder().encode(nonce));
    const publicKey = recoveryIdentityFromPhrase(VECTOR_PHRASE).publicKey;
    expect(ed25519.verify(signature, new TextEncoder().encode(nonce), publicKey)).toBe(true);
  });
});
