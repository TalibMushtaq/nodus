"use client";

// Web binding for the shared @repo/sdk recovery client (ADR-0002).
//
// The phrase crypto, challenge signing, online recovery, key materialization,
// and enrollment live in the SDK; this file binds them to the browser's
// IndexedDB phrase store and HTTP proxies.

import { createRecoveryClient } from "@repo/sdk";
import type { DevicePublicIdentity, RecoveryLoginResult } from "@repo/sdk";

import { STORE_RECOVERY, idbDelete, idbGet, idbPut } from "./db";
import { putFileKey } from "./keys";
import { putFolderKey } from "./folder-keys";
import { createWebRelayHttp } from "./adapters";
import { getOrCreateEncryptionIdentity } from "./device";

export interface RecoveryRecord {
  account_id: string;
  /** Normalized (lowercase, single-spaced) BIP39 mnemonic. */
  phrase: string;
  created_at: string;
}

// One client for the module: the deps are stateless wrappers over IndexedDB and
// the /api proxies.
const client = createRecoveryClient({
  http: createWebRelayHttp(),
  store: {
    async save(accountId, phrase) {
      await idbPut<RecoveryRecord>(STORE_RECOVERY, {
        account_id: accountId,
        phrase,
        created_at: new Date().toISOString(),
      });
    },
    async load(accountId) {
      const record = await idbGet<RecoveryRecord>(STORE_RECOVERY, accountId);
      return record?.phrase ?? null;
    },
    clear: (accountId) => idbDelete(STORE_RECOVERY, accountId),
  },
  putFileKey,
  putFolderKey,
});

export const createRecoveryPhrase = client.createPhrase;
export const recoveryPublicKey = client.publicKey;
export const isValidPhrase = client.isValid;
export const saveRecoveryPhrase = client.save;
export const loadRecoveryPhrase = client.load;
export const clearRecoveryPhrase = client.clear;
export const signRecoveryNonce = client.signNonce;
export const materializeRecoveryKeys = client.materialize;
export const enrollRecoveryKey = client.enroll;
export type { RecoveryLoginResult } from "@repo/sdk";

/**
 * Recover this account, publishing the fresh device's X25519 encryption key
 * (ADR-0008) so later uploads can seal envelopes to it directly.
 */
export function recoverAccount(
  email: string,
  phrase: string,
  device: DevicePublicIdentity,
): Promise<RecoveryLoginResult> {
  return client.recover(email, phrase, device, getOrCreateEncryptionIdentity().public_key);
}
