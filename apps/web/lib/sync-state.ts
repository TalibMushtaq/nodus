// Per-origin sync cursors for the web client. A device is a first-class sync
// origin: every event it emits carries `origin_id = device_id` and a strictly
// increasing `origin_sequence` (§18). The Relay enforces that monotonicity, so
// this store must allocate sequences atomically and be able to re-sync from the
// server's cursor after a `sequence_regression` rejection.

import { STORE_SYNC_STATE, idbGetAll, idbPut, openWebDb } from "./db";

export interface SyncStateRecord {
  origin_id: string;
  last_sequence: number;
  updated_at: string;
}

/**
 * Allocate the next `origin_sequence` for `originId`, atomically.
 *
 * The read-modify-write runs in one `readwrite` transaction. IndexedDB
 * serializes readwrite transactions on the same store across every connection
 * to the same database (including other tabs of this origin), so two concurrent
 * callers — or two tabs — can never receive the same sequence.
 */
export async function nextOriginSequence(originId: string): Promise<number> {
  const db = await openWebDb();
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_SYNC_STATE, "readwrite");
      const store = tx.objectStore(STORE_SYNC_STATE);
      const getReq = store.get(originId) as IDBRequest<SyncStateRecord | undefined>;
      let next = 1;
      getReq.onsuccess = () => {
        next = (getReq.result?.last_sequence ?? 0) + 1;
        store.put({ origin_id: originId, last_sequence: next, updated_at: new Date().toISOString() });
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

export async function getCursors(): Promise<SyncStateRecord[]> {
  return idbGetAll<SyncStateRecord>(STORE_SYNC_STATE);
}

export async function getCursor(originId: string): Promise<number> {
  const cursors = await getCursors();
  return cursors.find((c) => c.origin_id === originId)?.last_sequence ?? 0;
}

/**
 * Force a cursor to the server's value. Called after the Relay rejects a batch
 * with `sequence_regression`; the server is authoritative, so the local counter
 * must be reset rather than incremented from its stale value.
 */
export async function resyncOriginSequence(originId: string, serverSequence: number): Promise<void> {
  await idbPut<SyncStateRecord>(STORE_SYNC_STATE, {
    origin_id: originId,
    last_sequence: serverSequence,
    updated_at: new Date().toISOString(),
  });
}
