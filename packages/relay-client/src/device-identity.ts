//! Device identity for the LAN pairing flow — shared by web and mobile apps.
//!
//! Every client device needs a stable Ed25519 keypair to prove its identity
//! to Storage Nodes (challenge-response) and to bind pairing tokens. The key
//! is generated once per device, persisted by the app layer (IndexedDB /
//! localStorage on web, secure-store on mobile), and never leaves the device
//! — this module only shapes it for the wire.

import { ed25519 } from "@noble/curves/ed25519.js";

/** Shape persisted by apps. Keys are base64 so it survives JSON storage. */
export interface StoredDeviceIdentity {
  /** Human-ish stable id — first 16 hex chars of the public key */
  device_id: string;
  /** Ed25519 public key, base64 */
  public_key: string;
  /** Ed25519 private key seed (32 bytes), base64. NEVER leave the device. */
  private_key: string;
}

/** Derive the device id: first 16 hex chars of the public key. */
export function deriveDeviceId(publicKeyBytes: Uint8Array): string {
  return toHex(publicKeyBytes).slice(0, 16);
}

/** Generate a fresh device identity. Callers persist + memoize it. */
export function createDeviceIdentity(): StoredDeviceIdentity {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    device_id: deriveDeviceId(publicKey),
    public_key: base64Encode(publicKey),
    private_key: base64Encode(privateKey),
  };
}

/** Rehydrate identity bytes from storage for signing (challenge-response). */
export function identityPrivateKey(id: StoredDeviceIdentity): Uint8Array {
  return base64Decode(id.private_key);
}

/** Rehydrate identity public-key bytes (used by `NodeClient.pair`). */
export function identityPublicKey(id: StoredDeviceIdentity): Uint8Array {
  return base64Decode(id.public_key);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}