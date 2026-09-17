// Device-local activity log (the native counterpart to the web's IndexedDB
// `transfer_log`). The Relay exposes no account-wide activity feed, so each
// device records the terminal outcome of its own actions and the Activity tab
// reads them back.
//
// Only durable, non-secret fields are stored: the decrypted file name is kept
// for display, but never keys or content.

import { getDb } from "./db";

export type TransferLogKind =
  | "upload"
  | "download"
  | "delete"
  | "restore"
  | "purge"
  | "rename"
  | "move"
  | "conflict";

export type TransferLogOutcome = "complete" | "failed";

export interface TransferLogEntry {
  id: string;
  kind: TransferLogKind;
  fileId: string | null;
  /** Decrypted display name at the time of the action, when known. */
  fileName: string | null;
  detail: string | null;
  /** TransferPath of the transfer, for uploads/downloads. */
  path: string | null;
  outcome: TransferLogOutcome;
  createdAt: string;
}

/** Keep the log bounded; older rows beyond this are pruned on insert. */
const MAX_ENTRIES = 200;

interface Row {
  id: string;
  kind: string;
  file_id: string | null;
  file_name: string | null;
  detail: string | null;
  path: string | null;
  outcome: string;
  created_at: string;
}

function toEntry(row: Row): TransferLogEntry {
  return {
    id: row.id,
    kind: row.kind as TransferLogKind,
    fileId: row.file_id,
    fileName: row.file_name,
    detail: row.detail,
    path: row.path,
    outcome: row.outcome as TransferLogOutcome,
    createdAt: row.created_at,
  };
}

/**
 * Record one activity entry and prune the oldest rows past the cap. Returns the
 * stored entry so callers can prepend it to in-memory state without a re-read.
 */
export async function logTransfer(
  entry: Omit<TransferLogEntry, "id" | "createdAt"> & { id?: string; createdAt?: string },
): Promise<TransferLogEntry> {
  const db = await getDb();
  const stored: TransferLogEntry = {
    id: entry.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    kind: entry.kind,
    fileId: entry.fileId,
    fileName: entry.fileName,
    detail: entry.detail,
    path: entry.path,
    outcome: entry.outcome,
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
  await db.runAsync(
    `INSERT INTO transfer_log (id, kind, file_id, file_name, detail, path, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    stored.id,
    stored.kind,
    stored.fileId,
    stored.fileName,
    stored.detail,
    stored.path,
    stored.outcome,
    stored.createdAt,
  );
  await db.runAsync(
    `DELETE FROM transfer_log WHERE id IN (
       SELECT id FROM transfer_log ORDER BY created_at DESC LIMIT -1 OFFSET ?
     )`,
    MAX_ENTRIES,
  );
  return stored;
}

/** Most recent entries first. */
export async function listTransfers(limit = MAX_ENTRIES): Promise<TransferLogEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    `SELECT id, kind, file_id, file_name, detail, path, outcome, created_at
       FROM transfer_log ORDER BY created_at DESC LIMIT ?`,
    limit,
  );
  return rows.map(toEntry);
}

export async function clearTransfers(): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM transfer_log");
}
