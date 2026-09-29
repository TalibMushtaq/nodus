// Per-file File Encryption Key store (SQLite).
//
// The FEK is a secret the device must persist to decrypt its own uploads. It
// lives in SQLite rather than the keychain, whose per-item size limits make it
// unsuitable for an unbounded key set, but it is sealed with the device-local
// data key (see ../at-rest) so the database never holds it in the clear.

import { openAtRest, sealAtRest } from "../at-rest";
import { getDb } from "./db";

export async function putFileKey(fileId: string, fek: Uint8Array): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT OR REPLACE INTO file_keys (file_id, fek) VALUES (?, ?)",
    fileId,
    await sealAtRest(fek),
  );
}

export async function getFileKey(fileId: string): Promise<Uint8Array | undefined> {
  const db = await getDb();
  // A sealed value is TEXT; a pre-encryption row is a raw BLOB, so the union
  // lets this read both during migration.
  const row = await db.getFirstAsync<{ fek: Uint8Array | string }>(
    "SELECT fek FROM file_keys WHERE file_id = ?",
    fileId,
  );
  const value = row?.fek;
  if (value == null) return undefined;
  if (typeof value === "string") return (await openAtRest(value)) ?? undefined;
  // Legacy plaintext BLOB written before at-rest encryption existed.
  return value;
}

export async function deleteFileKey(fileId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM file_keys WHERE file_id = ?", fileId);
}
