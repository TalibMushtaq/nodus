/**
 * At-rest encryption for the account secrets kept in SQLite.
 *
 * The recovery phrase and per-file keys are account secrets, so they must not
 * sit in the app sandbox as plaintext: an Android cloud/adb backup or a rooted
 * device would otherwise expose the whole account. A random 256-bit data key is
 * held in the OS keychain (expo-secure-store, whose data is excluded from
 * Android backups), and values are sealed with AES-256-GCM before they reach
 * SQLite. The key stays device-bound, so a leaked database alone is useless.
 */

import * as SecureStore from "expo-secure-store";
import { getRandomBytes } from "expo-crypto";
import { gcm } from "@noble/ciphers/aes.js";

/** Keychain entry holding the device-local data key (never leaves the device). */
const DATA_KEY_NAME = "nodus.local.dataKey";
/** Marker so a sealed value is distinguishable from a legacy plaintext row. */
const SEALED_PREFIX = "v1:";
/** AES-GCM nonce length; 96 bits is the recommended size. */
const NONCE_BYTES = 12;

let cachedKey: Uint8Array | null = null;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function loadOrCreateDataKey(): Promise<Uint8Array> {
  if (cachedKey) return cachedKey;
  const stored = await SecureStore.getItemAsync(DATA_KEY_NAME);
  if (stored) {
    const key = fromHex(stored);
    if (key.length === 32) {
      cachedKey = key;
      return key;
    }
    // Corrupt/truncated key: fall through and mint a fresh one. Previously
    // sealed values then read as absent rather than crashing the app.
  }
  const fresh = getRandomBytes(32);
  await SecureStore.setItemAsync(DATA_KEY_NAME, toHex(fresh));
  cachedKey = fresh;
  return fresh;
}

/** Seal arbitrary bytes for storage, returning a self-describing text value. */
export async function sealAtRest(plaintext: Uint8Array): Promise<string> {
  const key = await loadOrCreateDataKey();
  const nonce = getRandomBytes(NONCE_BYTES);
  const ciphertext = gcm(key, nonce).encrypt(plaintext);
  // Prepend the nonce so the opener has everything it needs in one value; GCM's
  // tag is already appended to the ciphertext by the noble implementation.
  const packed = new Uint8Array(nonce.length + ciphertext.length);
  packed.set(nonce, 0);
  packed.set(ciphertext, nonce.length);
  return SEALED_PREFIX + toHex(packed);
}

/** True when a stored value was produced by `sealAtRest` (vs. a legacy row). */
export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

/**
 * Open a value produced by `sealAtRest`. Returns null when it cannot be opened
 * (wrong device, rotated key, corruption) so callers treat it as absent rather
 * than crashing.
 */
export async function openAtRest(sealed: string): Promise<Uint8Array | null> {
  if (!isSealed(sealed)) return null;
  try {
    const key = await loadOrCreateDataKey();
    const packed = fromHex(sealed.slice(SEALED_PREFIX.length));
    const nonce = packed.subarray(0, NONCE_BYTES);
    const ciphertext = packed.subarray(NONCE_BYTES);
    return gcm(key, nonce).decrypt(ciphertext);
  } catch {
    return null;
  }
}

export async function sealStringAtRest(plaintext: string): Promise<string> {
  return sealAtRest(new TextEncoder().encode(plaintext));
}

export async function openStringAtRest(sealed: string): Promise<string | null> {
  const bytes = await openAtRest(sealed);
  return bytes ? new TextDecoder().decode(bytes) : null;
}
