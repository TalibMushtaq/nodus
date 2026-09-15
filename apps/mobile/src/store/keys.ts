// Per-file File Encryption Key store (SQLite).
//
// The FEK is a secret, but it is one the device must persist to decrypt its own
// uploads, and it is already sealed to every other device/node as an envelope
// (so it is not the sole confidentiality boundary). It lives in SQLite with the
// rest of the file state rather than the keychain, whose per-item size limits
// make it unsuitable for an unbounded key set.

import { getDb } from "./db";

export async function putFileKey(fileId: string, fek: Uint8Array): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT OR REPLACE INTO file_keys (file_id, fek) VALUES (?, ?)",
    fileId,
    fek,
  );
}

export async function getFileKey(fileId: string): Promise<Uint8Array | undefined> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ fek: Uint8Array }>(
    "SELECT fek FROM file_keys WHERE file_id = ?",
    fileId,
  );
  return row?.fek ?? undefined;
}

export async function deleteFileKey(fileId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM file_keys WHERE file_id = ?", fileId);
}
