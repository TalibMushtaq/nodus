"use client";

// Keeps the browser's local content scoped to the account currently signed in.
//
// The web DB is one IndexedDB holding the catalog, file keys, trusted nodes,
// and the activity log. Logout wipes the decryption material but not the stores
// themselves, and login never reconciles them, so a second account signing in
// on the same browser (a shared machine, or the same browser after a Relay
// reset) could read rows the first account left behind. The activity log is the
// sharpest edge: it stores *decrypted* file names, so this is a plaintext leak,
// not just a stale cache. `claimAccountScope` runs before an authenticated
// session is surfaced; `releaseAccountScope` runs on logout.

import { clearLocalDatabase } from "./db";
import { resetTransferLog } from "./transfer-log";
import { clearRecoveryPhrase } from "./recovery";

/** localStorage marker naming the account whose data owns the local DB. */
const ACCOUNT_SCOPE_KEY = "nodus.account.scope";

function readScopedAccount(): string | null {
  try {
    return window.localStorage.getItem(ACCOUNT_SCOPE_KEY);
  } catch {
    // Storage disabled (private mode): treat as unknown so we clear defensively.
    return null;
  }
}

function writeScopedAccount(accountId: string | null): void {
  try {
    if (accountId === null) {
      window.localStorage.removeItem(ACCOUNT_SCOPE_KEY);
    } else {
      window.localStorage.setItem(ACCOUNT_SCOPE_KEY, accountId);
    }
  } catch {
    // Non-fatal: without the marker the next claim clears again, which is safe.
  }
}

/**
 * Point the local content stores at `accountId`, clearing them first when a
 * different account owned them before. Must resolve before the session is
 * exposed to the dashboard so no page can read the previous account's rows.
 *
 * `device_keys` (identity), `sync_state` (the device's monotonic sequence
 * counter), and the `recovery` store are kept: none are account content. The
 * previous account's recovery phrase is dropped explicitly when we know which
 * account it belonged to.
 */
export async function claimAccountScope(accountId: string): Promise<void> {
  const previous = readScopedAccount();
  if (previous === accountId) return;

  // A first-seen account (previous === null, e.g. an install from before
  // scoping existed) also clears: we cannot tell whether the rows on disk
  // belong to it or to a previous account, and a wrong guess leaks data.
  await resetTransferLog();
  await clearLocalDatabase({ keepSyncState: true });
  if (previous !== null && previous !== accountId) {
    // The previous account's phrase is a secret the next account must not find.
    await clearRecoveryPhrase(previous).catch(() => undefined);
  }
  writeScopedAccount(accountId);
}

/**
 * Drop the local content that belongs to the signed-out account so a shared
 * browser cannot read it under the next session. The device identity and
 * sequence counter survive; the account's recovery phrase is cleared by the
 * logout flow alongside this.
 */
export async function releaseAccountScope(): Promise<void> {
  await resetTransferLog();
  await clearLocalDatabase({ keepSyncState: true });
  writeScopedAccount(null);
}
