import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { STORE_TRANSFER_LOG, WEB_DB_NAME, idbPut } from "../db";
import {
  TRANSFER_LOG_LIMIT,
  clearTransfers,
  finishTransfer,
  listTransfers,
  logTransferAction,
  startTransfer,
} from "../transfer-log";

function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(WEB_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await deleteDb();
});

describe("transfer log", () => {
  it("records an in-progress entry, updates its outcome, and clears", async () => {
    const started = await startTransfer({ kind: "upload", fileId: "f1", fileName: "a.txt" });
    expect(started.outcome).toBe("in-progress");

    await finishTransfer(started.id, "complete", "2 shards");

    const rows = await listTransfers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fileName: "a.txt", outcome: "complete", detail: "2 shards" });

    await clearTransfers();
    expect(await listTransfers()).toEqual([]);
  });

  it("ignores updates for a missing entry", async () => {
    await finishTransfer("does-not-exist", "failed", "nope");
    expect(await listTransfers()).toEqual([]);
  });

  it("records one-shot delete/restore actions as completed entries", async () => {
    await logTransferAction({
      kind: "delete",
      fileId: "f1",
      fileName: "a.txt",
      outcome: "complete",
      detail: "Permanently deleted",
    });
    const rows = await listTransfers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "delete", outcome: "complete", detail: "Permanently deleted" });
  });

  it("caps the log and evicts the oldest entries", async () => {
    // Seed limit+2 entries with increasing timestamps, then insert one more to
    // trigger the trim.
    for (let index = 0; index < TRANSFER_LOG_LIMIT + 2; index += 1) {
      await idbPut(STORE_TRANSFER_LOG, {
        id: `id-${index}`,
        kind: "download",
        fileId: "f",
        fileName: `old-${index}`,
        outcome: "complete",
        at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
      });
    }
    await startTransfer({ kind: "upload", fileId: "new", fileName: "newest" });

    const rows = await listTransfers();
    expect(rows).toHaveLength(TRANSFER_LOG_LIMIT);
    expect(rows.some((row) => row.fileName === "newest")).toBe(true);
    expect(rows.some((row) => row.fileName === "old-0")).toBe(false);
  });
});
