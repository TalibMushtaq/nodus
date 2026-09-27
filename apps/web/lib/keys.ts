// Per-file encryption key (FEK) storage for the web client.
//
// The uploader generates a random FEK per file and encrypts every shard with
// it. The Relay and Storage Node only ever see ciphertext, so the FEK must be
// retained somewhere or the upload is undecryptable after the tab reloads.
// This store is that "somewhere" for v1.
//
// Scope: this store is the uploading device's local copy of the FEK. Cross-
// device/cross-node distribution is handled separately by lib/envelopes.ts,
// which seals the FEK to each recipient's identity and publishes
// KEY_ENVELOPE_ADDED events (Phase 14 F2). This store remains the fast local
// path so a reload can decrypt the device's own uploads without a Relay round
// trip; `fetchAndOpenFileKey` is the fallback for files this device did not
// upload and only has an envelope for.

import { STORE_KEYS, idbClear, idbDelete, idbGet, idbPut } from "./db";

export interface FileKeyRecord {
  file_id: string;
  /** Raw 32-byte AES-256-GCM File Encryption Key. */
  fek: Uint8Array;
  created_at: string;
}

/**
 * Persist a file's FEK. The uploader must await this before emitting any event
 * that references the file, otherwise a reload loses the only copy of the key.
 */
export async function putFileKey(fileId: string, fek: Uint8Array): Promise<void> {
  await idbPut<FileKeyRecord>(STORE_KEYS, {
    file_id: fileId,
    fek,
    created_at: new Date().toISOString(),
  });
}

export async function getFileKey(fileId: string): Promise<Uint8Array | undefined> {
  const record = await idbGet<FileKeyRecord>(STORE_KEYS, fileId);
  return record?.fek;
}

export async function deleteFileKey(fileId: string): Promise<void> {
  await idbDelete(STORE_KEYS, fileId);
}

/**
 * Drop every locally cached file/folder key. Called on logout so a shared
 * browser does not retain decryption material for the signed-out account.
 * The Relay envelopes remain the source of truth: the next sign-in re-opens
 * keys via `fetchAndOpenFileKey` / folder envelopes, so this only costs a
 * re-fetch, not data loss.
 *
 * Why raw at rest (defense-in-depth note): these keys must be usable offline
 * after a reload, so they cannot be sealed to a server-side secret. Wrapping
 * them in a device-local non-extractable key would not raise the bar against
 * same-origin XSS (the wrapper is equally reachable), which is why the
 * mitigation is logout/reset wiping plus the CSP headers instead.
 */
export async function clearFileKeys(): Promise<void> {
  await idbClear(STORE_KEYS);
}
