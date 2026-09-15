import { createDeviceIdentity } from "@repo/relay-client";
import type { StoredDeviceIdentity } from "@repo/relay-client";
import { isStoredDeviceIdentity, DEVICE_IDENTITY_KEY } from "@repo/sdk";

// Device identity persistence. Unlike a session this keypair is the device's
// long-lived Ed25519 identity, stays in localStorage, and never leaves the
// client — the Relay only ever sees the id + public key. The structural
// validation is shared with native via @repo/sdk so both platforms agree on
// what a valid record is.

export { DEVICE_IDENTITY_KEY };

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
