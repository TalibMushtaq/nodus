import { createDeviceIdentity } from "@repo/relay-client";
import type { StoredDeviceIdentity } from "@repo/relay-client";

// Device identity persistence. Unlike a session/JWT this keypair is the
// device's long-lived identity (Ed25519), stays in localStorage, and never
// leaves the client — the Relay only ever sees the id + public key.

export const DEVICE_IDENTITY_KEY = "nodus.device.identity";

/**
 * Returns the browser's persistent device identity, generating + storing one
 * on first use (Phase 7a §2/§3: login/register require device_id +
 * device_public_key for auto-registration beside session creation).
 */
export function getOrCreateDeviceIdentity(): StoredDeviceIdentity {
  const existing = localStorage.getItem(DEVICE_IDENTITY_KEY);
  if (existing) {
    try {
      return JSON.parse(existing) as StoredDeviceIdentity;
    } catch {
      // Corrupt store → regenerate below.
    }
  }
  const fresh = createDeviceIdentity();
  localStorage.setItem(DEVICE_IDENTITY_KEY, JSON.stringify(fresh));
  return fresh;
}