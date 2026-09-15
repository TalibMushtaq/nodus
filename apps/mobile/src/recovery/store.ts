// SQLite-backed recovery-phrase store (ADR-0002).
//
// The phrase never leaves the device; it is persisted so the Security view can
// reveal it and so a recovery can be re-run. Like the web client's IndexedDB
// `recovery` store, it is intentionally NOT cleared by "reset local data".

import type { RecoveryStore } from "@repo/sdk";

import { getDb } from "../store/db";

interface RecoveryRow {
  account_id: string;
  phrase: string;
  created_at: string;
}

export const sqliteRecoveryStore: RecoveryStore = {
  async save(accountId, phrase) {
    const db = await getDb();
    await db.runAsync(
      "INSERT OR REPLACE INTO recovery (account_id, phrase, created_at) VALUES (?, ?, ?)",
      accountId,
      phrase,
      new Date().toISOString(),
    );
  },
  async load(accountId) {
    const db = await getDb();
    const row = await db.getFirstAsync<RecoveryRow>(
      "SELECT phrase FROM recovery WHERE account_id = ?",
      accountId,
    );
    return row?.phrase ?? null;
  },
  async clear(accountId) {
    const db = await getDb();
    await db.runAsync("DELETE FROM recovery WHERE account_id = ?", accountId);
  },
};
