// Activity log for the Activity view.
//
// Entries are written locally first (so the UI is instant and works offline),
// then reconciled to the account-wide feed as `ACTIVITY_LOGGED` sync events by
// `ActivityProvider`. The same store also holds entries pulled back from the
// Relay/Node, deduped by `id`, so the feed is identical on every device and
// survives clearing browser data. The list is capped so it cannot grow without
// bound.

import { STORE_TRANSFER_LOG, idbClear, idbDelete, idbGetAll, idbPut } from "./db";
import type { ActivityRecord } from "@repo/protocol";

// Mirrors the protocol `ActivityKind` so entries pulled from other devices
// (which may log rename/move/conflict/purge) render without a mapping gap.
export type TransferKind =
  | "upload"
  | "download"
  | "delete"
  | "restore"
  | "purge"
  | "rename"
  | "move"
  | "conflict";
export type TransferOutcome = "in-progress" | "complete" | "failed";

/**
 * How the bytes moved, in the UI's shared transfer-path vocabulary
 * (`@repo/ui` PathIndicator). Stored with the entry because it cannot be
 * reconstructed later from the catalog: a file that landed via the Relay
 * buffer looks identical to one that went local P2P once it is NODE_STORED.
 * Maps from the transfer-manager's `TransferPath` at write time.
 */
export type ActivityPath = "local" | "relay" | "buffered" | "queued" | "offline";

export interface TransferLogEntry {
  /** uuid — the store's primary key and the event's `activity_id`. */
  id: string;
  kind: TransferKind;
  fileId: string;
  /** Decrypted display name for locally-logged entries; empty for entries
   *  pulled from the Relay/Node (names are E2E and resolved from the catalog). */
  fileName: string;
  outcome: TransferOutcome;
  /** Human-readable error/summary, when relevant. */
  detail?: string;
  /** Transfer path, when the action moved bytes (uploads/downloads). */
  path?: ActivityPath;
  /** ISO timestamp of the last update. */
  at: string;
  /** Origin device of a synced entry; absent for this device's own entries. */
  deviceId?: string;
  /** True once an entry has been accepted by the Relay (or pulled from it). */
  synced?: boolean;
}

/** Keep the newest N entries so the store stays bounded. */
export const TRANSFER_LOG_LIMIT = 200;

/**
 * Clearing the log records a cutoff rather than only deleting rows: synced
 * entries come back on the next fetch, so without a cutoff "Clear" would appear
 * to undo itself. Entries at or before the cutoff are hidden from reads.
 */
const CLEARED_AT_KEY = "nodus.activity.clearedAt";

function readClearedAt(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(CLEARED_AT_KEY) ?? "";
}

/** Epoch-ms of the local "Clear", or 0 when never cleared. */
function clearedAtMs(): number {
  const raw = readClearedAt();
  return raw === "" ? 0 : Number(raw) || 0;
}

/** Append a new (typically in-progress) entry and return it. */
export async function startTransfer(entry: {
  kind: TransferKind;
  fileId: string;
  fileName: string;
  path?: ActivityPath;
}): Promise<TransferLogEntry> {
  const record: TransferLogEntry = {
    id: crypto.randomUUID(),
    kind: entry.kind,
    fileId: entry.fileId,
    fileName: entry.fileName,
    outcome: "in-progress",
    path: entry.path,
    at: new Date().toISOString(),
  };
  await idbPut(STORE_TRANSFER_LOG, record);
  await trim();
  return record;
}

/**
 * Update the outcome/detail of an existing entry. `path` is set on completion
 * because the transfer-manager only reveals which path actually succeeded after
 * the shards finish; omitting it preserves any path recorded at start.
 */
export async function finishTransfer(
  id: string,
  outcome: Exclude<TransferOutcome, "in-progress">,
  detail?: string,
  path?: ActivityPath,
): Promise<void> {
  const rows = await idbGetAll<TransferLogEntry>(STORE_TRANSFER_LOG);
  const existing = rows.find((row) => row.id === id);
  if (!existing) return;
  await idbPut(STORE_TRANSFER_LOG, {
    ...existing,
    outcome,
    detail,
    path: path ?? existing.path,
    at: new Date().toISOString(),
    // A completed outcome must be re-emitted; an in-progress row is not sent.
    synced: false,
  });
}

/**
 * Record a one-shot action (delete/restore) that has no start/finish lifecycle.
 * Writes a single completed entry so it shows immediately in Activity.
 */
export async function logTransferAction(entry: {
  kind: Extract<TransferKind, "delete" | "restore">;
  fileId: string;
  fileName: string;
  outcome: Exclude<TransferOutcome, "in-progress">;
  detail?: string;
  path?: ActivityPath;
}): Promise<void> {
  await idbPut(STORE_TRANSFER_LOG, {
    id: crypto.randomUUID(),
    kind: entry.kind,
    fileId: entry.fileId,
    fileName: entry.fileName,
    outcome: entry.outcome,
    detail: entry.detail,
    path: entry.path,
    at: new Date().toISOString(),
    synced: false,
  } satisfies TransferLogEntry);
  await trim();
}

/**
 * Newest first. Entries at or before the last "Clear" are hidden (the cutoff is
 * what makes Clear stick against entries that sync back).
 */
export async function listTransfers(): Promise<TransferLogEntry[]> {
  const cutoff = clearedAtMs();
  const rows = await idbGetAll<TransferLogEntry>(STORE_TRANSFER_LOG);
  return rows
    .filter((row) => cutoff === 0 || Date.parse(row.at) > cutoff)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Terminal entries not yet accepted by the Relay. `synced === true` entries
 * (pulled from the Relay/Node) are never re-emitted; `in-progress` rows are
 * skipped because the sync feed records terminal outcomes only.
 */
export async function listUnsyncedTransfers(): Promise<TransferLogEntry[]> {
  const rows = await idbGetAll<TransferLogEntry>(STORE_TRANSFER_LOG);
  return rows.filter((row) => row.synced !== true && row.outcome !== "in-progress");
}

/** Mark entries as accepted so they are not re-emitted. */
export async function markTransfersSynced(ids: string[]): Promise<void> {
  const wanted = new Set(ids);
  const rows = await idbGetAll<TransferLogEntry>(STORE_TRANSFER_LOG);
  for (const row of rows) {
    if (wanted.has(row.id)) {
      await idbPut(STORE_TRANSFER_LOG, { ...row, synced: true });
    }
  }
}

/**
 * Insert entries pulled from the account-wide feed (Relay or Node), skipping
 * ones already cached. They are marked synced so they are not echoed back, and
 * their file name is left empty for the Activity view to resolve from the
 * decrypted catalog (names are E2E and never travel in the event).
 */
export async function importRemoteActivities(records: ActivityRecord[]): Promise<void> {
  if (records.length === 0) return;
  const existing = new Set(
    (await idbGetAll<TransferLogEntry>(STORE_TRANSFER_LOG)).map((row) => row.id),
  );
  for (const record of records) {
    if (existing.has(record.activity_id)) continue;
    await idbPut(STORE_TRANSFER_LOG, {
      id: record.activity_id,
      kind: record.kind as TransferKind,
      fileId: record.file_id ?? "",
      fileName: "",
      outcome: record.outcome,
      detail: record.detail ?? undefined,
      path: (record.path as ActivityPath | null) ?? undefined,
      at: record.created_at,
      deviceId: record.device_id,
      synced: true,
    } satisfies TransferLogEntry);
  }
  await trim();
}

/**
 * Clear the visible log and record a cutoff. Rows are kept so a later fetch
 * does not re-add them; the cutoff hides them from `listTransfers`.
 */
export async function clearTransfers(): Promise<void> {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(CLEARED_AT_KEY, String(Date.now()));
  }
  await idbClear(STORE_TRANSFER_LOG);
}

/** Drop the oldest entries once the cap is exceeded. */
async function trim(): Promise<void> {
  const rows = await listTransfers();
  if (rows.length <= TRANSFER_LOG_LIMIT) return;
  for (const stale of rows.slice(TRANSFER_LOG_LIMIT)) {
    await idbDelete(STORE_TRANSFER_LOG, stale.id);
  }
}
