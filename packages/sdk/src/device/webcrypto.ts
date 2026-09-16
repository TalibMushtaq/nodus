// Non-extractable WebCrypto Ed25519 device signing (ADR-0008 phase 3).
//
// The device signing key becomes a non-extractable CryptoKey so its private
// bytes never exist in JS or persistent storage; callers hold a handle and a
// `sign(message)` function instead of a seed. Envelope encryption uses the
// separate X25519 identity, so nothing here needs to export the private key.

import { deriveDeviceId } from "@repo/relay-client";

/** Async signing handle for a device identity. */
export interface DeviceSigner {
  deviceId: string;
  /** Ed25519 public key, base64 (the wire format the Relay/Node expect). */
  publicKey: string;
  /** Ed25519 signature over the message bytes, hex-encoded. */
  sign(message: string): Promise<string>;
}

export interface WebCryptoDeviceKeys {
  /** Non-extractable Ed25519 private key handle. */
  privateKey: CryptoKey;
  publicKeyB64: string;
  deviceId: string;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when this runtime provides WebCrypto Ed25519 (browsers, Node 20+). */
export function supportsWebCryptoEd25519(scope: Crypto = crypto): boolean {
  return typeof scope?.subtle?.generateKey === "function";
}

/**
 * Generate a non-extractable Ed25519 signing key. The public key is exported
 * for publication; the private key never leaves the crypto boundary.
 */
export async function generateWebCryptoDeviceKeys(scope: Crypto = crypto): Promise<WebCryptoDeviceKeys> {
  const pair = (await scope.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await scope.subtle.exportKey("raw", pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKeyB64: toBase64(raw),
    deviceId: deriveDeviceId(raw),
  };
}

/** Build a signing handle over an existing (non-extractable) private key. */
export function createDeviceSigner(
  privateKey: CryptoKey,
  deviceId: string,
  publicKey: string,
  scope: Crypto = crypto,
): DeviceSigner {
  return {
    deviceId,
    publicKey,
    async sign(message: string): Promise<string> {
      const signature = await scope.subtle.sign(
        { name: "Ed25519" },
        privateKey,
        new TextEncoder().encode(message),
      );
      return toHex(new Uint8Array(signature));
    },
  };
}
