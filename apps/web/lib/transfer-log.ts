// On-device activity log for the Activity view.
//
// There is no server-side activity/history endpoint (the Relay exposes only the
// current catalog), so Activity is honestly scoped to "this device": it records
// uploads/downloads (start → complete/failed via startTransfer/finishTransfer)
// and one-shot delete/restore actions (`logTransferAction`). The list is capped
// so it cannot grow without bound.

import { STORE_TRANSFER_LOG, idbClear, idbDelete, idbGetAll, idbPut } from "./db";

export type TransferKind = "upload" | "download" | "delete" | "restore";
export type TransferOutcome = "in-progress" | "complete" | "failed";

export interface TransferLogEntry {
  /** uuid — the store's primary key. */
  id: string;
  kind: TransferKind;
  fileId: string;
  fileName: string;
  outcome: TransferOutcome;
  /** Human-readable error/summary, when relevant. */
  detail?: string;
  /** ISO timestamp of the last update. */
  at: string;
}

/** Keep the newest N entries so the store stays bounded. */
export const TRANSFER_LOG_LIMIT = 200;

/** Append a new (typically in-progress) entry and return it. */
export async function startTransfer(entry: {
  kind: TransferKind;
  fileId: string;
  fileName: string;
}): Promise<TransferLogEntry> {
  const record: TransferLogEntry = {
    id: crypto.randomUUID(),
    kind: entry.kind,
    fileId: entry.fileId,
    fileName: entry.fileName,
    outcome: "in-progress",
    at: new Date().toISOString(),
  };
  await idbPut(STORE_TRANSFER_LOG, record);
  await trim();
  return record;
}

/** Update the outcome/detail of an existing entry. */
export async function finishTransfer(
  id: string,
  outcome: Exclude<TransferOutcome, "in-progress">,
  detail?: string,
): Promise<void> {
  const rows = await idbGetAll<TransferLogEntry>(STORE_TRANSFER_LOG);
  const existing = rows.find((row) => row.id === id);
  if (!existing) return;
  await idbPut(STORE_TRANSFER_LOG, { ...existing, outcome, detail, at: new Date().toISOString() });
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
}): Promise<void> {
  await idbPut(STORE_TRANSFER_LOG, {
    id: crypto.randomUUID(),
    kind: entry.kind,
    fileId: entry.fileId,
    fileName: entry.fileName,
    outcome: entry.outcome,
    detail: entry.detail,
    at: new Date().toISOString(),
  } satisfies TransferLogEntry);
  await trim();
}

/** Newest first. */
export async function listTransfers(): Promise<TransferLogEntry[]> {
  const rows = await idbGetAll<TransferLogEntry>(STORE_TRANSFER_LOG);
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

export async function clearTransfers(): Promise<void> {
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
