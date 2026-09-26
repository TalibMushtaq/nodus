// Deterministic Ed25519 device identity for the e2e harnesses. The shell
// generates a seed per device and passes it in, so the uploader (device A) and
// the downloader (device B) can each reproduce the keypair the account/device
// was registered with.

import { ed25519 } from "@noble/curves/ed25519.js";

export interface HarnessIdentity {
  deviceId: string;
  /** Ed25519 public key, base64 — exactly what the Relay stores/returns. */
  publicKeyB64: string;
  privateKey: Uint8Array;
  /**
   * Sign a message's UTF-8 bytes and return the hex-encoded Ed25519 signature.
   * This is the `DeviceMessageSigner` shape the node's `X-Nodus-Signature`
   * check expects; the product's web signer produces the same hex over the same
   * bytes (see `createDeviceSigner`), so a node cannot tell the harness apart.
   */
  sign(message: string): string;
}

export function identityFromSeed(seedHex: string): HarnessIdentity {
  const privateKey = Uint8Array.from(Buffer.from(seedHex, "hex"));
  if (privateKey.length !== 32) {
    throw new Error("seed must be 32 bytes of hex (64 chars)");
  }
  const publicKey = ed25519.getPublicKey(privateKey);
  // Mirrors @repo/relay-client deriveDeviceId: first 16 hex chars of the pubkey.
  const deviceId = Buffer.from(publicKey).toString("hex").slice(0, 16);
  return {
    deviceId,
    publicKeyB64: Buffer.from(publicKey).toString("base64"),
    privateKey,
    sign(message: string): string {
      const signature = ed25519.sign(new TextEncoder().encode(message), privateKey);
      return Buffer.from(signature).toString("hex");
    },
  };
}
