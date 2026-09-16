import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

import { getOrCreateDevice, DEVICE_IDENTITY_KEY } from "../device";

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

// End-to-end for the ADR-0008 phase 3 web identity: a non-extractable CryptoKey
// is generated and persisted in IndexedDB, only the public identity is written
// to localStorage, and the signer's signatures verify against the public key.
describe("web device signer (ADR-0008 phase 3)", () => {
  it("creates a persistent non-extractable identity that signs verifiably", async () => {
    const first = await getOrCreateDevice();

    expect(first.identity.device_id).toHaveLength(16);
    expect(fromBase64(first.identity.public_key)).toHaveLength(32);

    // Only the public half is persisted outside IndexedDB.
    const stored = localStorage.getItem(DEVICE_IDENTITY_KEY);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!) as Record<string, unknown>;
    expect(parsed.device_id).toBe(first.identity.device_id);
    expect(parsed.public_key).toBe(first.identity.public_key);
    expect(parsed.private_key).toBeUndefined();

    const signature = await first.signer.sign("nonce-abc");
    const valid = ed25519.verify(
      fromHex(signature),
      new TextEncoder().encode("nonce-abc"),
      fromBase64(first.identity.public_key),
    );
    expect(valid).toBe(true);
  });
});
