// Non-secret client preferences (key/value) in SQLite.
//
// Distinct from the keychain: these are user choices like shard size, not
// credentials, and there can be many.

import { getDb } from "./db";

export async function getPreference(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM preferences WHERE key = ?",
    key,
  );
  return row?.value ?? null;
}

export async function setPreference(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)",
    key,
    value,
  );
}
