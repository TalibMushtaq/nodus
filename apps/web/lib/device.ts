// Web device identity (ADR-0008 phase 3).
//
// The signing key is a non-extractable WebCrypto Ed25519 `CryptoKey` persisted
// in IndexedDB; only the public identity (device_id + public key) lives in
// localStorage. Signing goes through a handle, so the private bytes never exist
// in JS or in storage. Envelope encryption uses the separate X25519 encryption
// identity (ADR-0008 phase 1), never the signing key.

import {
  createDeviceSigner,
  createEncryptionIdentity,
  generateWebCryptoDeviceKeys,
  isStoredEncryptionIdentity,
  supportsWebCryptoEd25519,
  DEVICE_IDENTITY_KEY,
  ENCRYPTION_IDENTITY_KEY,
  type DevicePublicIdentity,
  type DeviceSigner,
  type StoredEncryptionIdentity,
} from "@repo/sdk";

import { STORE_DEVICE_KEYS, idbDelete, idbGet, idbPut } from "./db";

export { DEVICE_IDENTITY_KEY, ENCRYPTION_IDENTITY_KEY };

/** The single signing-key record id in `device_keys`. */
const SIGNING_KEY_ID = "ed25519";

interface StoredDeviceKeys {
  id: string;
  /** Non-extractable Ed25519 key handle; structured-cloned by IndexedDB. */
  privateKey: CryptoKey;
  publicKey: string;
  deviceId: string;
}

export interface WebDevice {
  identity: DevicePublicIdentity;
  signer: DeviceSigner;
}

// One load per page: generating the key twice would strand the first key.
let cached: Promise<WebDevice> | null = null;

/** The device's public identity and non-extractable signing handle. */
export function getOrCreateDevice(): Promise<WebDevice> {
  if (!cached) {
    cached = loadOrCreateDevice().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

async function loadOrCreateDevice(): Promise<WebDevice> {
  if (!supportsWebCryptoEd25519()) {
    throw new Error(
      "This browser does not support WebCrypto Ed25519, which the device signing key requires.",
    );
  }

  const stored = await idbGet<StoredDeviceKeys>(STORE_DEVICE_KEYS, SIGNING_KEY_ID);
  if (stored?.privateKey && stored.deviceId && stored.publicKey) {
    const identity = { device_id: stored.deviceId, public_key: stored.publicKey };
    writePublicIdentity(identity);
    return {
      identity,
      signer: createDeviceSigner(stored.privateKey, identity.device_id, identity.public_key),
    };
  }

  const keys = await generateWebCryptoDeviceKeys();
  await idbPut<StoredDeviceKeys>(STORE_DEVICE_KEYS, {
    id: SIGNING_KEY_ID,
    privateKey: keys.privateKey,
    publicKey: keys.publicKeyB64,
    deviceId: keys.deviceId,
  });
  const identity = { device_id: keys.deviceId, public_key: keys.publicKeyB64 };
  writePublicIdentity(identity);
  return { identity, signer: createDeviceSigner(keys.privateKey, identity.device_id, identity.public_key) };
}

/** Only the public half is persisted outside IndexedDB. */
function writePublicIdentity(identity: DevicePublicIdentity): void {
  localStorage.setItem(DEVICE_IDENTITY_KEY, JSON.stringify(identity));
}

/**
 * Returns this browser's persistent X25519 encryption identity, generating +
 * storing one on first use. Its public half is published to the Relay so other
 * devices seal envelopes to it directly.
 *
 * Why async + IndexedDB: the private half used to live as JSON in
 * `localStorage`, where any injected script could synchronously dump it and
 * decrypt every envelope for the account. It now lives in IndexedDB (with an
 * in-memory cache for the session) so a trivial `localStorage` scrape no
 * longer yields a decryption oracle; only the publishable public half stays in
 * `localStorage` for synchronous sealing paths. A legacy `localStorage` record
 * is migrated once and its private bytes removed. Note this is defense-in-
 * depth, not a boundary: same-origin XSS can still read IndexedDB, so the
 * Content-Security-Policy headers remain the primary XSS mitigation.
 */
export function getOrCreateEncryptionIdentity(): Promise<StoredEncryptionIdentity> {
  if (encMemory) return Promise.resolve(encMemory);
  if (!encPending) {
    encPending = loadOrCreateEncryptionIdentity().then(
      (identity) => {
        encMemory = identity;
        encPending = null;
        return identity;
      },
      (err) => {
        encPending = null;
        throw err;
      },
    );
  }
  return encPending;
}

/**
 * Synchronous read of the publishable public half only (sealing never needs
 * the private key). Returns null before the async identity has been created.
 */
export function getEncryptionPublicKey(): string | null {
  if (encMemory) return encMemory.public_key;
  try {
    const raw = localStorage.getItem(ENCRYPTION_IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (isStoredEncryptionIdentity(parsed)) return parsed.public_key;
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { public_key?: unknown }).public_key === "string") {
      return (parsed as { public_key: string }).public_key;
    }
    return null;
  } catch {
    return null;
  }
}

/** In-memory private identity for this session, if it has been loaded. */
export function getCachedEncryptionIdentity(): StoredEncryptionIdentity | null {
  return encMemory;
}

/**
 * Forget the encryption identity in memory, IndexedDB, and the legacy
 * `localStorage` record. Used on logout so a shared browser does not keep a
 * decryption oracle for the signed-out account.
 */
export async function clearEncryptionIdentity(): Promise<void> {
  encMemory = null;
  encPending = null;
  try {
    localStorage.removeItem(ENCRYPTION_IDENTITY_KEY);
  } catch {
    // Storage unavailable (e.g. SSR) — IndexedDB cleanup below still runs.
  }
  try {
    await idbDelete(STORE_DEVICE_KEYS, X25519_KEY_ID);
  } catch {
    // Best-effort: a failed delete must not block logout.
  }
}

/** IndexedDB record id for the X25519 identity alongside the signing key. */
const X25519_KEY_ID = "x25519";

interface StoredEncryptionIdentityRecord {
  id: string;
  public_key: string;
  private_key: string;
}

let encMemory: StoredEncryptionIdentity | null = null;
let encPending: Promise<StoredEncryptionIdentity> | null = null;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function readLegacyLocalIdentity(): StoredEncryptionIdentity | null {
  try {
    const existing = localStorage.getItem(ENCRYPTION_IDENTITY_KEY);
    if (!existing) return null;
    const parsed = JSON.parse(existing) as unknown;
    if (isStoredEncryptionIdentity(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function cachePublicHalf(identity: StoredEncryptionIdentity): void {
  // Only the publishable public half stays synchronously readable; private
  // bytes never touch localStorage again after migration.
  try {
    localStorage.setItem(ENCRYPTION_IDENTITY_KEY, JSON.stringify({ public_key: identity.public_key }));
  } catch {
    // Storage full/blocked — the IndexedDB copy remains authoritative.
  }
}

async function loadOrCreateEncryptionIdentity(): Promise<StoredEncryptionIdentity> {
  // No IndexedDB (SSR/tests without the fake): fall back to the legacy
  // localStorage record so callers still function.
  if (!hasIndexedDb()) {
    const legacy = readLegacyLocalIdentity();
    if (legacy) return legacy;
    const fresh = createEncryptionIdentity();
    try {
      localStorage.setItem(ENCRYPTION_IDENTITY_KEY, JSON.stringify(fresh));
    } catch {
      // Ignore persistence failure; the in-memory copy still works.
    }
    return fresh;
  }

  try {
    const stored = await idbGet<StoredEncryptionIdentityRecord>(STORE_DEVICE_KEYS, X25519_KEY_ID);
    if (stored && typeof stored.public_key === "string" && typeof stored.private_key === "string") {
      const identity = { public_key: stored.public_key, private_key: stored.private_key };
      cachePublicHalf(identity);
      return identity;
    }
  } catch {
    // Corrupt store → regenerate below.
  }

  // One-time migration: adopt the legacy localStorage identity so the device
  // keeps its published public key instead of re-pairing.
  const legacy = readLegacyLocalIdentity();
  const identity = legacy ?? createEncryptionIdentity();
  try {
    await idbPut<StoredEncryptionIdentityRecord>(STORE_DEVICE_KEYS, {
      id: X25519_KEY_ID,
      public_key: identity.public_key,
      private_key: identity.private_key,
    });
  } catch {
    // Quota/blocked — fall through; the memory + public-half cache still work.
  }
  cachePublicHalf(identity);
  return identity;
}
