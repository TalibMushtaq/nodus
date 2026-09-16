import { createDeviceIdentity } from "@repo/relay-client";
import type { StoredDeviceIdentity } from "@repo/relay-client";
import {
  createEncryptionIdentity,
  isStoredDeviceIdentity,
  isStoredEncryptionIdentity,
  DEVICE_IDENTITY_KEY,
  ENCRYPTION_IDENTITY_KEY,
} from "@repo/sdk";
import type { StoredEncryptionIdentity } from "@repo/sdk";

// Device identity persistence. Unlike a session this keypair is the device's
// long-lived Ed25519 identity, stays in localStorage, and never leaves the
// client — the Relay only ever sees the id + public key. The structural
// validation is shared with native via @repo/sdk so both platforms agree on
// what a valid record is.

export { DEVICE_IDENTITY_KEY, ENCRYPTION_IDENTITY_KEY };

/**
 * Returns the browser's persistent device identity, generating + storing one
 * on first use (Phase 7a §2/§3: login/register require device_id +
 * device_public_key for auto-registration beside session creation).
 */
export function getOrCreateDeviceIdentity(): StoredDeviceIdentity {
  const existing = localStorage.getItem(DEVICE_IDENTITY_KEY);
  if (existing) {
    try {
      const identity = JSON.parse(existing) as unknown;
      if (isStoredDeviceIdentity(identity)) {
        return identity;
      }
    } catch {
      // Corrupt store → regenerate below.
    }
  }
  const fresh = createDeviceIdentity();
  localStorage.setItem(DEVICE_IDENTITY_KEY, JSON.stringify(fresh));
  return fresh;
}

/**
 * Returns this browser's persistent X25519 encryption identity (ADR-0008),
 * generating + storing one on first use. Its public half is published to the
 * Relay so other devices seal envelopes to it directly; the private half only
 * ever opens those envelopes. Kept separate from the Ed25519 signing identity so
 * signing can later become non-extractable without losing envelope access.
 */
export function getOrCreateEncryptionIdentity(): StoredEncryptionIdentity {
  const existing = localStorage.getItem(ENCRYPTION_IDENTITY_KEY);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (isStoredEncryptionIdentity(parsed)) {
        return parsed;
      }
    } catch {
      // Corrupt store → regenerate below.
    }
  }
  const fresh = createEncryptionIdentity();
  localStorage.setItem(ENCRYPTION_IDENTITY_KEY, JSON.stringify(fresh));
  return fresh;
}
