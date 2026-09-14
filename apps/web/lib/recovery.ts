"use client";

// Account recovery phrase handling (ADR-0002).
//
// The phrase is generated on this device at registration, shown once, and kept
// in the same local IndexedDB as the file keys so the Security page can reveal
// and copy it later. It never leaves the device: only the derived Ed25519
// public key is sent to the Relay. This is the same threat model as the FEKs
// already stored locally — the device is trusted; the phrase adds an offline
// escape hatch if every device is lost.

import {
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  normalizeRecoveryPhrase,
  recoveryIdentityFromPhrase,
  signRecoveryChallenge,
} from "@repo/core";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { STORE_RECOVERY, idbDelete, idbGet, idbPut } from "./db";
import { exportEnvelopes, openFekFromEnvelope } from "./envelopes";
import { putFileKey } from "./keys";
import { putFolderKey } from "./folder-keys";
import type { SessionInfo } from "./session";

export interface RecoveryRecord {
  account_id: string;
  /** Normalized (lowercase, single-spaced) BIP39 mnemonic. */
  phrase: string;
  created_at: string;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Generate a fresh 24-word phrase for a new or regenerated recovery key. */
export function createRecoveryPhrase(): string {
  return generateRecoveryPhrase();
}

/** The account recovery Ed25519 public key (base64), sent to the Relay. */
export function recoveryPublicKey(phrase: string): string {
  return toBase64(recoveryIdentityFromPhrase(phrase).publicKey);
}

/** Validate a user-entered phrase before deriving a key from it. */
export function isValidPhrase(phrase: string): boolean {
  return isValidRecoveryPhrase(phrase);
}

/** Persist this account's phrase locally so it can be revealed later. */
export async function saveRecoveryPhrase(accountId: string, phrase: string): Promise<void> {
  await idbPut<RecoveryRecord>(STORE_RECOVERY, {
    account_id: accountId,
    phrase: normalizeRecoveryPhrase(phrase),
    created_at: new Date().toISOString(),
  });
}

export async function loadRecoveryPhrase(accountId: string): Promise<string | null> {
  const record = await idbGet<RecoveryRecord>(STORE_RECOVERY, accountId);
  return record?.phrase ?? null;
}

export async function clearRecoveryPhrase(accountId: string): Promise<void> {
  await idbDelete(STORE_RECOVERY, accountId);
}

/**
 * Enroll or rotate the account recovery public key on the Relay. The phrase's
 * private half never travels; the Relay only receives the derived public key.
 * Any envelopes sealed to a previous recovery key are dropped server-side, so
 * the caller must re-seal existing keys immediately afterwards.
 */
export interface RecoveryLoginResult {
  ok: boolean;
  error?: string;
  session?: SessionInfo;
}

/** Sign a Relay recovery nonce (hex string) with the phrase's recovery key. */
export function signRecoveryNonce(phrase: string, nonce: string): string {
  return signRecoveryChallenge(phrase, new TextEncoder().encode(nonce));
}

/**
 * Online account recovery (ADR-0002): prove the phrase to the Relay with a
 * signed nonce, register this fresh device, and start a session. No password is
 * involved, so this works even if the password is forgotten.
 */
export async function recoverAccount(
  email: string,
  phrase: string,
  device: StoredDeviceIdentity,
): Promise<RecoveryLoginResult> {
  const challengeRes = await fetch("/api/auth/recovery/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const challenge = (await challengeRes.json().catch(() => null)) as
    | { nonce?: string; recovery_public_key?: string; error?: string }
    | null;
  if (!challengeRes.ok || !challenge?.nonce || !challenge.recovery_public_key) {
    return { ok: false, error: challenge?.error ?? "Recovery is not available for that account" };
  }
  // Catch a wrong phrase locally (clearer message) before spending the nonce.
  if (recoveryPublicKey(phrase) !== challenge.recovery_public_key) {
    return { ok: false, error: "That recovery phrase does not match this account" };
  }

  const signature = signRecoveryNonce(phrase, challenge.nonce);
  const res = await fetch("/api/auth/recovery", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      nonce: challenge.nonce,
      signature,
      device_id: device.device_id,
      device_public_key: device.public_key,
    }),
  });
  const json = (await res.json().catch(() => null)) as (SessionInfo & { error?: string }) | null;
  if (!res.ok) {
    return { ok: false, error: json?.error ?? "Recovery failed" };
  }
  return { ok: true, session: json as SessionInfo };
}

/**
 * Populate this device's local key stores from the account's recovery
 * envelopes, so files and folders become readable immediately after recovery
 * without waiting for the WebSocket. Returns how many keys were unlocked.
 */
export async function materializeRecoveryKeys(phrase: string): Promise<{ files: number; folders: number }> {
  const seed = recoveryIdentityFromPhrase(phrase).privateKey;
  const backup = await exportEnvelopes();
  let files = 0;
  let folders = 0;
  for (const envelope of backup.file_envelopes) {
    if (envelope.recipient_kind !== "recovery") continue;
    try {
      await putFileKey(envelope.file_id, openFekFromEnvelope(envelope.encrypted_key, seed));
      files += 1;
    } catch {
      // Not the current recovery key (a rotated orphan) or corrupt; skip.
    }
  }
  for (const envelope of backup.folder_envelopes) {
    if (envelope.recipient_kind !== "recovery") continue;
    try {
      await putFolderKey(envelope.folder_id, openFekFromEnvelope(envelope.encrypted_key, seed));
      folders += 1;
    } catch {
      // Same as above.
    }
  }
  return { files, folders };
}

export async function enrollRecoveryKey(publicKey: string): Promise<void> {
  const res = await fetch("/api/account/recovery", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recovery_public_key: publicKey }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `recovery enrollment failed: ${res.status}`);
  }
}
