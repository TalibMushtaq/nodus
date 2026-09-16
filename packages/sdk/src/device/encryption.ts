// Per-device X25519 encryption identity (ADR-0008).
//
// Separate from the Ed25519 signing identity: the public half is published to
// the Relay so senders seal file/folder key envelopes to it directly, and the
// private half only ever opens those envelopes. Keeping it independent lets the
// signing key be non-extractable without also having to produce X25519.

import { generateEncryptionKeypair } from "@repo/core";
import type { SecureStore } from "../adapters.js";

/** Storage key for the encryption identity — stable across releases. */
export const ENCRYPTION_IDENTITY_KEY = "nodus.device.encryption";

export interface StoredEncryptionIdentity {
  /** X25519 public key, base64 — published to the Relay. */
  public_key: string;
  /** X25519 private key, base64. NEVER leaves the device. */
  private_key: string;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Generate a fresh X25519 encryption identity. Callers persist + memoize it. */
export function createEncryptionIdentity(): StoredEncryptionIdentity {
  const pair = generateEncryptionKeypair();
  return {
    public_key: toBase64(pair.publicKey),
    private_key: toBase64(pair.privateKey),
  };
}

function isStoredEncryptionIdentity(value: unknown): value is StoredEncryptionIdentity {
  if (typeof value !== "object" || value === null) return false;
  const id = value as Record<string, unknown>;
  return (
    typeof id.public_key === "string" &&
    id.public_key.length > 0 &&
    typeof id.private_key === "string" &&
    id.private_key.length > 0
  );
}

/**
 * Load the persisted encryption identity, generating and storing one on first
 * use. A corrupt record is replaced rather than surfaced (the device re-pairs;
 * a parse error would brick the app).
 */
export async function getOrCreateEncryptionIdentity(
  store: SecureStore,
): Promise<StoredEncryptionIdentity> {
  const raw = await store.get(ENCRYPTION_IDENTITY_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isStoredEncryptionIdentity(parsed)) return parsed;
    } catch {
      // Fall through and regenerate.
    }
  }
  const fresh = createEncryptionIdentity();
  await store.set(ENCRYPTION_IDENTITY_KEY, JSON.stringify(fresh));
  return fresh;
}

/** Rehydrate the X25519 public-key bytes (used when sealing to this device). */
export function encryptionPublicKeyBytes(id: StoredEncryptionIdentity): Uint8Array {
  return fromBase64(id.public_key);
}

/** Rehydrate the X25519 private-key bytes (used to open envelopes). */
export function encryptionPrivateKeyBytes(id: StoredEncryptionIdentity): Uint8Array {
  return fromBase64(id.private_key);
}
