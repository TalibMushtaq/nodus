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

import { STORE_DEVICE_KEYS, idbGet, idbPut } from "./db";

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
 */
export function getOrCreateEncryptionIdentity(): StoredEncryptionIdentity {
  const existing = localStorage.getItem(ENCRYPTION_IDENTITY_KEY);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (isStoredEncryptionIdentity(parsed)) {
        return parsed;
      }
    } catch {
      // Corrupt store → regenerate below.
    }
  }
  const fresh = createEncryptionIdentity();
  localStorage.setItem(ENCRYPTION_IDENTITY_KEY, JSON.stringify(fresh));
  return fresh;
}
