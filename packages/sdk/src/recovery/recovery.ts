// Account recovery phrase handling (ADR-0002), shared by web and native.
//
// The phrase is generated on the device, shown once, and kept in the platform's
// local store so it can be revealed later. It never leaves the device: only the
// derived Ed25519 public key is sent to the Relay. Online recovery proves the
// phrase with a signed nonce, registers the fresh device, and starts a session
// — no password involved — then unlocks the account's recovery-sealed file and
// folder keys from the envelope backup.

import {
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  normalizeRecoveryPhrase,
  recoveryIdentityFromPhrase,
  signRecoveryChallenge,
} from "@repo/core";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import type { RelayHttp } from "../adapters.js";
import type { SessionInfo } from "../auth.js";
import { openFekFromEnvelope, type EnvelopeExport } from "../envelopes/envelopes.js";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Persists the phrase locally; the platform supplies the storage. */
export interface RecoveryStore {
  save(accountId: string, phrase: string): Promise<void>;
  load(accountId: string): Promise<string | null>;
  clear(accountId: string): Promise<void>;
}

export interface RecoveryDeps {
  http: RelayHttp;
  store: RecoveryStore;
  putFileKey(fileId: string, key: Uint8Array): Promise<void>;
  putFolderKey(folderId: string, key: Uint8Array): Promise<void>;
}

export interface RecoveryLoginResult {
  ok: boolean;
  error?: string;
  session?: SessionInfo;
}

export interface RecoveryClient {
  /** Generate a fresh 24-word phrase for a new or regenerated recovery key. */
  createPhrase(): string;
  /** The account recovery Ed25519 public key (base64), sent to the Relay. */
  publicKey(phrase: string): string;
  /** Validate a user-entered phrase before deriving a key from it. */
  isValid(phrase: string): boolean;
  /** Persist this account's phrase locally so it can be revealed later. */
  save(accountId: string, phrase: string): Promise<void>;
  load(accountId: string): Promise<string | null>;
  clear(accountId: string): Promise<void>;
  /** Sign a Relay recovery nonce (hex string) with the phrase's recovery key. */
  signNonce(phrase: string, nonce: string): string;
  /** Online recovery: prove the phrase, register this device, start a session. */
  recover(
    email: string,
    phrase: string,
    device: StoredDeviceIdentity,
    encryptionPublicKey?: string,
  ): Promise<RecoveryLoginResult>;
  /** Unlock this device's local key stores from recovery-sealed envelopes. */
  materialize(phrase: string): Promise<{ files: number; folders: number }>;
  /** Enroll or rotate the account recovery public key on the Relay. */
  enroll(publicKey: string): Promise<void>;
}

export function createRecoveryClient(deps: RecoveryDeps): RecoveryClient {
  function publicKey(phrase: string): string {
    return toBase64(recoveryIdentityFromPhrase(phrase).publicKey);
  }

  return {
    createPhrase: () => generateRecoveryPhrase(),
    publicKey,
    isValid: (phrase) => isValidRecoveryPhrase(phrase),

    async save(accountId, phrase) {
      // Normalize before storing so reveal/compare is stable.
      await deps.store.save(accountId, normalizeRecoveryPhrase(phrase));
    },
    load: (accountId) => deps.store.load(accountId),
    clear: (accountId) => deps.store.clear(accountId),

    signNonce: (phrase, nonce) => signRecoveryChallenge(phrase, new TextEncoder().encode(nonce)),

    async recover(email, phrase, device, encryptionPublicKey) {
      const challengeRes = await deps.http.request<{
        nonce?: string;
        recovery_public_key?: string;
        error?: string;
      }>("/auth/recovery/challenge", { method: "POST", body: { email } });
      const challenge = challengeRes.json;
      if (!challengeRes.ok || !challenge?.nonce || !challenge.recovery_public_key) {
        return { ok: false, error: challenge?.error ?? "Recovery is not available for that account" };
      }
      // Catch a wrong phrase locally (clearer message) before spending the nonce.
      if (publicKey(phrase) !== challenge.recovery_public_key) {
        return { ok: false, error: "That recovery phrase does not match this account" };
      }

      const signature = signRecoveryChallenge(phrase, new TextEncoder().encode(challenge.nonce));
      const res = await deps.http.request<SessionInfo & { error?: string }>("/auth/recovery", {
        method: "POST",
        body: {
          email,
          nonce: challenge.nonce,
          signature,
          device_id: device.device_id,
          device_public_key: device.public_key,
          device_encryption_public_key: encryptionPublicKey,
        },
      });
      if (!res.ok) {
        return { ok: false, error: res.json?.error ?? "Recovery failed" };
      }
      return { ok: true, session: res.json as SessionInfo };
    },

    async materialize(phrase) {
      const seed = recoveryIdentityFromPhrase(phrase).privateKey;
      const backupRes = await deps.http.request<EnvelopeExport>("/envelopes/export");
      const backup = backupRes.json;
      let files = 0;
      let folders = 0;
      if (!backupRes.ok || !backup) return { files, folders };

      for (const envelope of backup.file_envelopes) {
        if (envelope.recipient_kind !== "recovery") continue;
        try {
          await deps.putFileKey(envelope.file_id, openFekFromEnvelope(envelope.encrypted_key, seed));
          files += 1;
        } catch {
          // Not the current recovery key (a rotated orphan) or corrupt; skip.
        }
      }
      for (const envelope of backup.folder_envelopes) {
        if (envelope.recipient_kind !== "recovery") continue;
        try {
          await deps.putFolderKey(envelope.folder_id, openFekFromEnvelope(envelope.encrypted_key, seed));
          folders += 1;
        } catch {
          // Same as above.
        }
      }
      return { files, folders };
    },

    async enroll(publicKeyValue) {
      const res = await deps.http.request("/account/recovery", {
        method: "PUT",
        body: { recovery_public_key: publicKeyValue },
      });
      if (!res.ok) {
        throw new Error(res.error ?? `recovery enrollment failed: ${res.status}`);
      }
    },
  };
}
