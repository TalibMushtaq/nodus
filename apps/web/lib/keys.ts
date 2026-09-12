// Per-file encryption key (FEK) storage for the web client.
//
// The uploader generates a random FEK per file and encrypts every shard with
// it. The Relay and Storage Node only ever see ciphertext, so the FEK must be
// retained somewhere or the upload is undecryptable after the tab reloads.
// This store is that "somewhere" for v1.
//
// Scope: same-device durability only. There is no cross-device/cross-node key
// distribution yet — `packages/core` has `sealFekForRecipient`/`openFekEnvelope`
// and the Relay has a `key_envelopes` table, but no write path wires them
// together (§25 follow-up, tracked in Todo.md). Until that lands, a file
// uploaded from this browser profile is readable only from this profile.

import { STORE_KEYS, idbDelete, idbGet, idbPut } from "./db";

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
