import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { WEB_DB_NAME } from "../db";
import { logTransferAction, listTransfers } from "../transfer-log";
import { nextOriginSequence, getCursor } from "../sync-state";
import { claimAccountScope, releaseAccountScope } from "../account-scope";

const SCOPE_KEY = "nodus.account.scope";

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

describe("account scope", () => {
  it("clears the previous account's activity when a different account claims the DB", async () => {
    await claimAccountScope("account-a");
    await logTransferAction({
      kind: "delete",
      fileId: "f1",
      fileName: "salary-2026.pdf",
      outcome: "complete",
    });
    expect(await listTransfers()).toHaveLength(1);

    await claimAccountScope("account-b");
    expect(await listTransfers()).toEqual([]);
  });

  it("keeps the device sequence counter across accounts", async () => {
    await claimAccountScope("account-a");
    await nextOriginSequence("device-1");
    await nextOriginSequence("device-1");

    await claimAccountScope("account-b");
    expect(await getCursor("device-1")).toBe(2);
  });

  it("does not clear when the same account re-claims", async () => {
    await claimAccountScope("account-a");
    await logTransferAction({
      kind: "delete",
      fileId: "f1",
      fileName: "a.txt",
      outcome: "complete",
    });

    await claimAccountScope("account-a");
    expect(await listTransfers()).toHaveLength(1);
  });

  it("release wipes activity and forgets the scope marker", async () => {
    await claimAccountScope("account-a");
    await logTransferAction({
      kind: "delete",
      fileId: "f1",
      fileName: "a.txt",
      outcome: "complete",
    });

    await releaseAccountScope();
    expect(await listTransfers()).toEqual([]);
    expect(globalThis.localStorage.getItem(SCOPE_KEY)).toBeNull();
  });
});
