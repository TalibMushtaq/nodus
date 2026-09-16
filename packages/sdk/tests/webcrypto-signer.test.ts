import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

import {
  createDeviceSigner,
  generateWebCryptoDeviceKeys,
  supportsWebCryptoEd25519,
} from "../src/device/webcrypto.js";

function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function fromHex(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("WebCrypto device signer (ADR-0008 phase 3)", () => {
  it("produces non-extractable keys that sign verifiable messages", async () => {
    // WebCrypto Ed25519 is present in browsers and Node 20+; skip elsewhere.
    if (!supportsWebCryptoEd25519()) return;

    const keys = await generateWebCryptoDeviceKeys();
    expect(keys.privateKey.extractable).toBe(false);
    expect(keys.deviceId).toHaveLength(16);
    expect(fromBase64(keys.publicKeyB64)).toHaveLength(32);

    const signer = createDeviceSigner(keys.privateKey, keys.deviceId, keys.publicKeyB64);
    const signatureHex = await signer.sign("nonce-123");

    // The signature must verify against the published public key over the exact
    // message bytes — the contract the Relay and Rust node enforce.
    const valid = ed25519.verify(
      fromHex(signatureHex),
      new TextEncoder().encode("nonce-123"),
      fromBase64(keys.publicKeyB64),
    );
    expect(valid).toBe(true);

    // A different message must not verify.
    const wrong = ed25519.verify(
      fromHex(signatureHex),
      new TextEncoder().encode("nonce-124"),
      fromBase64(keys.publicKeyB64),
    );
    expect(wrong).toBe(false);
  });
});
