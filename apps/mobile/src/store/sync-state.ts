// Per-origin sync sequence allocation (SQLite).
//
// Every emitted event needs a monotonic `origin_sequence` per origin id. The
// read-modify-write runs in an exclusive transaction so two concurrent callers
// (e.g. an upload's file + version events) cannot allocate the same number.

import { getDb } from "./db";

export async function nextOriginSequence(originId: string): Promise<number> {
  const db = await getDb();
  let next = 1;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const row = await txn.getFirstAsync<{ sequence: number }>(
      "SELECT sequence FROM sync_state WHERE origin_id = ?",
      originId,
    );
    next = (row?.sequence ?? 0) + 1;
    await txn.runAsync(
      "INSERT OR REPLACE INTO sync_state (origin_id, sequence) VALUES (?, ?)",
      originId,
      next,
    );
  });
  return next;
}
