// Activity log backing the Activity tab.
//
// Entries are written locally first (instant + offline), then reconciled to the
// account-wide feed as ACTIVITY_LOGGED sync events. The same store also holds
// entries pulled from the Relay/Node, deduped by `id`, so the feed is the same
// on every device and survives clearing app data.
//
// Only durable, non-secret fields are stored: the decrypted file name is kept
// for this device's own entries, but never keys or content. Remote entries
// leave `file_name` null and resolve the display name from the local catalog.

import { getDb } from "./db";
import { getPreference, setPreference } from "./preferences";
import type { ActivityRecord } from "@repo/protocol";

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
  /** Origin device of a synced entry; null for this device's own entries. */
  deviceId: string | null;
  /** True once accepted by the Relay (or pulled from it). */
  synced: boolean;
}

/** Keep the log bounded; older rows beyond this are pruned on insert. */
const MAX_ENTRIES = 200;

/** Preference key holding the epoch-ms of the last local "Clear". */
const CLEARED_AT_KEY = "activity.clearedAt";

interface Row {
  id: string;
  kind: string;
  file_id: string | null;
  file_name: string | null;
  detail: string | null;
  path: string | null;
  outcome: string;
  created_at: string;
  synced: number;
  device_id: string | null;
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
    deviceId: row.device_id,
    synced: row.synced === 1,
  };
}

async function clearedAtMs(): Promise<number> {
  const raw = await getPreference(CLEARED_AT_KEY);
  return raw ? Number(raw) || 0 : 0;
}

/**
 * Record one activity entry and prune the oldest rows past the cap. Returns the
 * stored entry so callers can prepend it to in-memory state without a re-read.
 */
export async function logTransfer(
  entry: Omit<TransferLogEntry, "id" | "createdAt" | "synced" | "deviceId"> & {
    id?: string;
    createdAt?: string;
    deviceId?: string | null;
    synced?: boolean;
  },
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
    deviceId: entry.deviceId ?? null,
    synced: entry.synced ?? false,
  };
  await db.runAsync(
    `INSERT OR REPLACE INTO transfer_log
       (id, kind, file_id, file_name, detail, path, outcome, created_at, synced, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    stored.id,
    stored.kind,
    stored.fileId,
    stored.fileName,
    stored.detail,
    stored.path,
    stored.outcome,
    stored.createdAt,
    stored.synced ? 1 : 0,
    stored.deviceId,
  );
  await db.runAsync(
    `DELETE FROM transfer_log WHERE id IN (
       SELECT id FROM transfer_log ORDER BY created_at DESC LIMIT -1 OFFSET ?
     )`,
    MAX_ENTRIES,
  );
  return stored;
}

/**
 * Most recent entries first, hiding anything at or before the last local
 * "Clear" (the cutoff is what makes Clear stick against synced entries).
 */
export async function listTransfers(limit = MAX_ENTRIES): Promise<TransferLogEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    `SELECT id, kind, file_id, file_name, detail, path, outcome, created_at, synced, device_id
       FROM transfer_log ORDER BY created_at DESC LIMIT ?`,
    limit,
  );
  const cutoff = await clearedAtMs();
  return rows
    .map(toEntry)
    .filter((entry) => cutoff === 0 || Date.parse(entry.createdAt) > cutoff);
}

/**
 * Terminal entries not yet accepted by the Relay. `in-progress` rows do not
 * exist on mobile (only terminal outcomes are logged), and entries pulled from
 * the feed are marked synced so they are never echoed back.
 */
export async function listUnsyncedTransfers(limit = 50): Promise<TransferLogEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    `SELECT id, kind, file_id, file_name, detail, path, outcome, created_at, synced, device_id
       FROM transfer_log WHERE synced = 0 ORDER BY created_at ASC LIMIT ?`,
    limit,
  );
  return rows.map(toEntry);
}

/** Mark entries as accepted so they are not re-emitted. */
export async function markTransfersSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => "?").join(",");
  await db.runAsync(
    `UPDATE transfer_log SET synced = 1 WHERE id IN (${placeholders})`,
    ...ids,
  );
}

/**
 * Insert entries pulled from the account-wide feed, skipping ones already
 * cached. Marked synced so they are not echoed back; `file_name` stays null for
 * the Activity view to resolve from the decrypted catalog.
 */
export async function importRemoteActivities(records: ActivityRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const existing = new Set(
    (await db.getAllAsync<{ id: string }>("SELECT id FROM transfer_log")).map((row) => row.id),
  );
  for (const record of records) {
    if (existing.has(record.activity_id)) continue;
    await db.runAsync(
      `INSERT OR IGNORE INTO transfer_log
         (id, kind, file_id, file_name, detail, path, outcome, created_at, synced, device_id)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, ?)`,
      record.activity_id,
      record.kind,
      record.file_id ?? null,
      record.detail ?? null,
      record.path ?? null,
      record.outcome,
      record.created_at,
      record.device_id,
    );
  }
}

/**
 * Clear the visible log and record a cutoff. Rows are deleted and the cutoff
 * hides anything that syncs back afterwards.
 */
export async function clearTransfers(): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM transfer_log");
  await setPreference(CLEARED_AT_KEY, String(Date.now()));
}
