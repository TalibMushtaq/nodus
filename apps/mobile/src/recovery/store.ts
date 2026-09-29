// SQLite-backed recovery-phrase store (ADR-0002).
//
// The phrase never leaves the device; it is persisted so the Security view can
// reveal it and so a recovery can be re-run. Like the web client's IndexedDB
// `recovery` store, it is intentionally NOT cleared by "reset local data".
// Because the phrase is the account master secret, it is sealed with the
// device-local key (see ../at-rest) before it reaches SQLite.

import type { RecoveryStore } from "@repo/sdk";

import { isSealed, openStringAtRest, sealStringAtRest } from "../at-rest";
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
      await sealStringAtRest(phrase),
      new Date().toISOString(),
    );
  },
  async load(accountId) {
    const db = await getDb();
    const row = await db.getFirstAsync<RecoveryRow>(
      "SELECT phrase FROM recovery WHERE account_id = ?",
      accountId,
    );
    const stored = row?.phrase;
    if (!stored) return null;
    // A pre-encryption row is plaintext; only sealed rows need opening.
    return isSealed(stored) ? openStringAtRest(stored) : stored;
  },
  async clear(accountId) {
    const db = await getDb();
    await db.runAsync("DELETE FROM recovery WHERE account_id = ?", accountId);
  },
};
