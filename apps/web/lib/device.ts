import { createDeviceIdentity } from "@repo/relay-client";
import type { StoredDeviceIdentity } from "@repo/relay-client";

// Device identity persistence. Unlike a session/JWT this keypair is the
// device's long-lived identity (Ed25519), stays in localStorage, and never
// leaves the client — the Relay only ever sees the id + public key.

export const DEVICE_IDENTITY_KEY = "nodus.device.identity";

function isStoredDeviceIdentity(value: unknown): value is StoredDeviceIdentity {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.device_id === "string" &&
    identity.device_id.length > 0 &&
    typeof identity.public_key === "string" &&
    identity.public_key.length > 0 &&
    typeof identity.private_key === "string" &&
    identity.private_key.length > 0
  );
}

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
